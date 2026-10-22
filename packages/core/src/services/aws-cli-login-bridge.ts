import { INativeService } from "../interfaces/i-native-service";

export type AwsCliFailureKind = "authentication" | "configuration" | "network" | "installation" | "cancelled" | "command";

export class AwsCliLoginError extends Error {
  profileMissing = false;

  constructor(public readonly kind: AwsCliFailureKind, message: string) {
    super(message);
    this.name = "AwsCliLoginError";
  }
}

export interface AwsCliLoginLease {
  directory: string;
  id: string;
  assertCurrent(): void;
}

// Never attach child-process errors: they can contain stdout, credentials, or login URLs.
export class AwsCliLoginBridge {
  private executable: string;
  private readonly credentialVariables = [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_SECURITY_TOKEN",
    "AWS_ACCESS_KEY",
    "AWS_SECRET_KEY",
    "AWS_PROFILE",
    "AWS_DEFAULT_PROFILE",
    "AWS_ROLE_ARN",
    "AWS_ROLE_SESSION_NAME",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  ];

  constructor(private native: INativeService) {}

  environment(): NodeJS.ProcessEnv {
    const environment = { ...this.native.process.env };
    this.credentialVariables.forEach((key) => delete environment[key]);
    ["AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_LOGIN_CACHE_DIRECTORY", "AWS_CA_BUNDLE"].forEach((key) => {
      if (environment[key]) {
        environment[key] = this.native.path.resolve(environment[key]);
      }
    });
    environment.AWS_PAGER = "";
    environment.AWS_CLI_AUTO_PROMPT = "off";
    environment.AWS_EC2_METADATA_DISABLED = "true";
    return environment;
  }

  async checkVersion(): Promise<void> {
    if (!this.native.execFile) {
      throw new AwsCliLoginError("installation", "AWS CLI Login requires native argv execution support. Update Leapp.");
    }
    const candidates = ["aws", "/opt/homebrew/bin/aws", "/usr/local/bin/aws", "/usr/local/aws-cli/v2/current/bin/aws"];
    for (const candidate of this.executable ? [this.executable] : candidates) {
      try {
        const version = await this.execute(candidate, ["--version"]);
        const match = /aws-cli\/(\d+)\.(\d+)\.(\d+)/.exec(version);
        if (!match || Number(match[1]) !== 2 || Number(match[2]) < 32) {
          throw new AwsCliLoginError("installation", "AWS CLI Login requires AWS CLI v2.32.0 or later (v2). Upgrade the installed AWS CLI.");
        }
        this.executable = candidate;
        return;
      } catch (error) {
        if ((error as AwsCliLoginError).kind !== "installation" || (error as Error).message.includes("Upgrade")) {
          throw error;
        }
      }
    }
    throw new AwsCliLoginError(
      "installation",
      "AWS CLI not found. Install AWS CLI v2.32.0 or later; on macOS use /usr/local/bin or /opt/homebrew/bin."
    );
  }

  async command(args: string[], environment = this.environment()): Promise<string> {
    if (!this.executable) {
      await this.checkVersion();
    }
    return this.execute(this.executable, args, environment);
  }

  cancellationToken(source: string): string {
    const path = `${this.lockDirectory(source)}.cancel`;
    try {
      return String(this.native.fs.readFileSync(path, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        return "";
      }
      throw new AwsCliLoginError("configuration", "Cannot read AWS CLI Login coordination state. Check permissions on ~/.Leapp/aws-cli-login.");
    }
  }

  async withLock<T>(
    source: string,
    action: (lease: AwsCliLoginLease) => Promise<T>,
    cancelled: () => boolean,
    token = this.cancellationToken(source)
  ): Promise<T> {
    const directory = this.lockDirectory(source);
    const id = this.native.crypto.randomBytes(16).toString("hex");
    const fs = this.native.fs;
    fs.mkdirSync(this.native.path.dirname(directory), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 16 * 60 * 1000;
    let acquired = false;
    while (!acquired) {
      if (cancelled() || token !== this.cancellationToken(source)) {
        throw new AwsCliLoginError("cancelled", "AWS CLI login was cancelled.");
      }
      try {
        fs.mkdirSync(directory, { mode: 0o700 });
        fs.writeFileSync(this.native.path.join(directory, "owner"), String(this.native.process.pid), { mode: 0o600 });
        fs.writeFileSync(this.native.path.join(directory, "lease"), id, { mode: 0o600 });
        acquired = true;
      } catch (error) {
        if (error.code !== "EEXIST") {
          throw new AwsCliLoginError("configuration", "Cannot coordinate AWS CLI Login. Check permissions on ~/.Leapp/aws-cli-login.");
        }
        if (this.removeStaleLock(directory)) {
          continue;
        }
        if (Date.now() >= deadline) {
          throw new AwsCliLoginError("command", "Another AWS CLI Login operation is still running. Complete it or Stop the session before retrying.");
        }
        await this.delay();
      }
    }
    const lease = {
      directory,
      id,
      assertCurrent: () => {
        if (cancelled() || token !== this.cancellationToken(source) || fs.existsSync(this.native.path.join(directory, "cancel"))) {
          throw new AwsCliLoginError("cancelled", "AWS CLI login was cancelled. No credentials were published.");
        }
      },
    };
    try {
      lease.assertCurrent();
      return await action(lease);
    } finally {
      this.cancelChild(directory);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  cancel(source: string): void {
    const directory = this.lockDirectory(source);
    this.native.fs.mkdirSync(this.native.path.dirname(directory), { recursive: true, mode: 0o700 });
    this.native.fs.writeFileSync(`${directory}.cancel`, this.native.crypto.randomBytes(16).toString("hex"), { mode: 0o600 });
    if (this.native.fs.existsSync(directory)) {
      try {
        this.native.fs.writeFileSync(this.native.path.join(directory, "cancel"), "", { mode: 0o600 });
        this.cancelChild(directory);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw new AwsCliLoginError("command", "Unable to cancel the pending AWS CLI login. Close its Terminal window and retry Stop.");
        }
      }
    }
  }

  async login(source: string, lease: AwsCliLoginLease, region: string): Promise<void> {
    lease.assertCurrent();
    if (this.native.process.platform !== "darwin") {
      throw new AwsCliLoginError("configuration", "Interactive AWS CLI Login currently requires macOS Terminal.");
    }
    const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
    const environment = this.environment();
    const forwarded = [
      "HOME",
      "PATH",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "NO_PROXY",
      "https_proxy",
      "http_proxy",
      "no_proxy",
      "AWS_CONFIG_FILE",
      "AWS_SHARED_CREDENTIALS_FILE",
      "AWS_LOGIN_CACHE_DIRECTORY",
      "AWS_CA_BUNDLE",
      "AWS_REGION",
      "AWS_DEFAULT_REGION",
      "AWS_ENDPOINT_URL",
      "AWS_ENDPOINT_URL_SIGNIN",
      "AWS_USE_FIPS_ENDPOINT",
      "AWS_USE_DUALSTACK_ENDPOINT",
      "AWS_RETRY_MODE",
      "AWS_MAX_ATTEMPTS",
      "AWS_PAGER",
      "AWS_CLI_AUTO_PROMPT",
      "AWS_EC2_METADATA_DISABLED",
    ].filter((key) => environment[key] !== undefined);
    // Terminal does not inherit the application's environment. Pass configuration overrides
    // explicitly, and remove credential variables inherited from the user's terminal shell.
    const command = [
      "/usr/bin/env",
      ...this.credentialVariables.flatMap((key) => ["-u", key]),
      ...forwarded.map((key) => quote(`${key}=${environment[key]}`)),
      quote(this.executable),
      "login",
      "--profile",
      quote(source),
      "--region",
      quote(region),
    ].join(" ");
    const pidFile = quote(this.native.path.join(lease.directory, `${lease.id}.child`));
    const resultFile = quote(this.native.path.join(lease.directory, `${lease.id}.result`));
    const cancelFile = quote(this.native.path.join(lease.directory, "cancel"));
    const leaseFile = quote(this.native.path.join(lease.directory, "lease"));
    // Register before checking the lease, then exec in the same PID. A Terminal command
    // queued until after Stop cannot launch login, even if a subsequent operation reuses the directory.
    const childScript = `printf '%s' "$$" > ${pidFile} || exit 130; if [ "$(cat ${leaseFile} 2>/dev/null)" = ${quote(
      lease.id
    )} ] && [ ! -f ${cancelFile} ]; then exec ${command}; else exit 130; fi`;
    const scriptPath = this.native.path.join(lease.directory, `${lease.id}.sh`);
    const script = `umask 077\nif [ "$1" = child ]; then\n${childScript}\nfi\ntrap ':' INT\n/bin/sh ${quote(
      scriptPath
    )} child < /dev/tty\nleapp_login_status=$?\nprintf '%s' "$leapp_login_status" > ${resultFile}\n`;
    try {
      this.native.fs.writeFileSync(scriptPath, script, { mode: 0o600, flag: "wx" });
    } catch (_) {
      lease.assertCurrent();
      throw new AwsCliLoginError("configuration", "Cannot create the private AWS CLI login script. Check permissions on ~/.Leapp/aws-cli-login.");
    }
    lease.assertCurrent();
    // A foreground noninteractive shell keeps the login child's prompts attached to the
    // foreground process group. Terminal history contains only a path, not environment values.
    const terminalCommand = `/bin/sh ${quote(scriptPath)}`;
    const appleScript = `tell application "Terminal"\ndo script ${JSON.stringify(terminalCommand)}\nactivate\nend tell`;
    await this.execute("/usr/bin/osascript", ["-e", appleScript]);

    const deadline = Date.now() + 15 * 60 * 1000;
    while (Date.now() < deadline) {
      lease.assertCurrent();
      const result = this.native.path.join(lease.directory, `${lease.id}.result`);
      if (this.native.fs.existsSync(result)) {
        const status = String(this.native.fs.readFileSync(result, "utf8")).trim();
        if (status !== "0") {
          throw new AwsCliLoginError("authentication", "AWS CLI login did not complete successfully. Complete login in Terminal and retry Start.");
        }
        return;
      }
      await this.delay();
    }
    throw new AwsCliLoginError("cancelled", "AWS CLI login timed out after 15 minutes. Retry Start when ready to authenticate.");
  }

  private execute(executable: string, args: string[], env = this.environment()): Promise<string> {
    return new Promise((resolve, reject) => {
      this.native.execFile(executable, args, { env, timeout: 60000, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
        if (!error) {
          resolve(String(stdout));
          return;
        }
        const diagnostic = String(stderr);
        if (error.code === "ENOENT") {
          reject(new AwsCliLoginError("installation", "AWS CLI executable could not be found."));
        } else if (/could not connect|connection.*(error|closed)|timed? ?out|endpointconnection|SSL validation|proxyconnection/i.test(diagnostic)) {
          reject(
            new AwsCliLoginError("network", "AWS CLI could not reach AWS. Check the network, proxy, and certificate configuration, then retry.")
          );
        } else if (
          /expiredtoken|token.*expired|expired.*token|login.*(required|expired)|not logged in|no login|unable to locate credentials|no credentials|refresh.*(expired|invalid)|invalidgrant|invalid_grant|invalid.*refresh|reauthenticat|(?:please|run).*aws login/i.test(
            diagnostic
          )
        ) {
          reject(new AwsCliLoginError("authentication", "AWS CLI login is missing or expired. Interactive login is required."));
        } else if (/profile.*(not.*found|could not be found)/i.test(diagnostic)) {
          const failure = new AwsCliLoginError(
            "configuration",
            "The AWS CLI source profile does not exist. Create it with aws login or Start the Leapp session."
          );
          failure.profileMissing = true;
          reject(failure);
        } else if (/config.*(error|invalid)|unable to parse|invalid.*config|login_session/i.test(diagnostic)) {
          reject(
            new AwsCliLoginError(
              "configuration",
              "AWS CLI profile configuration is invalid. Check the source login profile and AWS configuration overrides."
            )
          );
        } else {
          reject(
            new AwsCliLoginError(
              "command",
              "AWS CLI command failed. Check AWS CLI installation, permissions, and source-profile configuration. No login was opened."
            )
          );
        }
      });
    });
  }

  private lockDirectory(source: string): string {
    const env = this.environment();
    const home = this.native.os.homedir();
    const key = JSON.stringify([
      source,
      env.AWS_CONFIG_FILE || this.native.path.join(home, ".aws", "config"),
      env.AWS_LOGIN_CACHE_DIRECTORY || this.native.path.join(home, ".aws", "login", "cache"),
    ]);
    const hash = this.native.crypto.createHash("sha256").update(key).digest("hex");
    return this.native.path.join(this.native.os.homedir(), ".Leapp", "aws-cli-login", hash);
  }

  private removeStaleLock(directory: string): boolean {
    try {
      const owner = Number(this.native.fs.readFileSync(this.native.path.join(directory, "owner"), "utf8"));
      if (!Number.isSafeInteger(owner) || owner <= 0) {
        return false;
      }
      try {
        this.native.process.kill(owner, 0);
      } catch (error) {
        if (error.code === "ESRCH") {
          this.cancelChild(directory);
          this.native.fs.rmSync(directory, { recursive: true, force: true });
          return true;
        }
      }
    } catch (_) {
      // A concurrent lock creator may not have written its owner yet.
    }
    return false;
  }

  private cancelChild(directory: string): void {
    const leaseFile = this.native.path.join(directory, "lease");
    if (!this.native.fs.existsSync(leaseFile)) {
      return;
    }
    const id = String(this.native.fs.readFileSync(leaseFile, "utf8"));
    if (!/^[a-f0-9]{32}$/.test(id)) {
      return;
    }
    const path = this.native.path.join(directory, `${id}.child`);
    if (!this.native.fs.existsSync(path) || this.native.fs.existsSync(this.native.path.join(directory, `${id}.result`))) {
      return;
    }
    const pid = Number(this.native.fs.readFileSync(path, "utf8"));
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        this.native.process.kill(pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") {
          throw new AwsCliLoginError("command", "Unable to stop AWS CLI login. Close its Terminal window.");
        }
      }
    }
  }

  private delay(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 500));
  }
}
