/* eslint-disable @typescript-eslint/naming-convention -- Test fixtures use AWS environment variable names. */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { AwsCliLoginBridge, AwsCliLoginError } from "./aws-cli-login-bridge";

describe("AwsCliLoginBridge", () => {
  let native: any;
  let bridge: AwsCliLoginBridge;
  let files: Map<string, string>;
  let directories: Set<string>;
  const path = require("path");

  beforeEach(() => {
    jest.useRealTimers();
    files = new Map();
    directories = new Set();
    native = {
      process: { env: { PATH: "/bin" }, platform: "darwin", pid: 111, kill: jest.fn() },
      path,
      os: { homedir: () => "/mock-home" },
      crypto: require("crypto"),
      fs: {
        existsSync: (name: string) => files.has(name) || directories.has(name),
        mkdirSync: jest.fn((name: string, options: any) => {
          if (directories.has(name) && !options.recursive) {
            throw Object.assign(new Error("exists"), { code: "EEXIST" });
          }
          directories.add(name);
        }),
        writeFileSync: jest.fn((name: string, data: string) => files.set(name, data)),
        readFileSync: jest.fn((name: string) => {
          if (!files.has(name)) {
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          }
          return files.get(name);
        }),
        rmSync: jest.fn((name: string) => {
          directories.delete(name);
          for (const file of [...files.keys()]) {
            if (file.startsWith(`${name}/`)) {
              files.delete(file);
            }
          }
        }),
      },
      execFile: jest.fn((_exe: string, _args: string[], _options: any, callback: any) => callback(null, "aws-cli/2.32.0 Python/3", "")),
    };
    bridge = new AwsCliLoginBridge(native);
  });

  test("discovers the macOS binary without shell interpolation", async () => {
    native.execFile.mockImplementation((exe: string, _args: string[], _options: any, callback: any) =>
      exe === "aws" ? callback({ code: "ENOENT" }, "", "") : callback(null, "aws-cli/2.32.0 Python/3", "")
    );
    await bridge.checkVersion();
    await bridge.command(["configure", "export-credentials", "--profile", "source;unsafe", "--format", "process"]);
    expect(native.execFile.mock.calls[1][0]).toBe("/opt/homebrew/bin/aws");
    expect(native.execFile.mock.calls[2][1]).toContain("source;unsafe");
    expect(native.execFile.mock.calls[2][2].shell).toBeUndefined();
  });

  test.each(["aws-cli/1.40.0", "aws-cli/2.31.99", "not a version"])("rejects unsupported version %s", async (version) => {
    native.execFile.mockImplementation((_exe: string, _args: string[], _opts: any, cb: any) => cb(null, version, ""));
    await expect(bridge.checkVersion()).rejects.toMatchObject({ kind: "installation" });
  });

  test.each(["aws-cli/2.32.0", "aws-cli/2.33.1", "aws-cli/2.100.0"])("accepts supported version %s", async (version) => {
    native.execFile.mockImplementation((_exe: string, _args: string[], _opts: any, cb: any) => cb(null, version, ""));
    await expect(bridge.checkVersion()).resolves.toBeUndefined();
  });

  test("reports missing installation and missing argv support explicitly", async () => {
    native.execFile.mockImplementation((_exe: string, _args: string[], _opts: any, cb: any) => cb({ code: "ENOENT" }, "", ""));
    await expect(bridge.checkVersion()).rejects.toThrow("Install AWS CLI");
    native.execFile = undefined;
    await expect(bridge.checkVersion()).rejects.toThrow("argv");
  });

  test("removes inherited credential sources while retaining AWS config/cache/network overrides", async () => {
    native.process.env = {
      AWS_ACCESS_KEY_ID: "inherited",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "token",
      AWS_SECURITY_TOKEN: "token",
      AWS_PROFILE: "wrong",
      AWS_DEFAULT_PROFILE: "wrong",
      AWS_ROLE_ARN: "wrong",
      AWS_WEB_IDENTITY_TOKEN_FILE: "wrong",
      AWS_CONTAINER_CREDENTIALS_FULL_URI: "wrong",
      AWS_CONTAINER_AUTHORIZATION_TOKEN: "wrong",
      AWS_CONFIG_FILE: "/custom/config",
      AWS_SHARED_CREDENTIALS_FILE: "/custom/credentials",
      AWS_LOGIN_CACHE_DIRECTORY: "/custom/cache",
      AWS_CA_BUNDLE: "/custom/ca",
      HTTPS_PROXY: "http://proxy",
    };
    await bridge.checkVersion();
    const env = native.execFile.mock.calls[0][2].env;
    expect(env).toMatchObject({
      AWS_CONFIG_FILE: "/custom/config",
      AWS_SHARED_CREDENTIALS_FILE: "/custom/credentials",
      AWS_LOGIN_CACHE_DIRECTORY: "/custom/cache",
      AWS_CA_BUNDLE: "/custom/ca",
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_CLI_AUTO_PROMPT: "off",
    });
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_PROFILE).toBeUndefined();
    expect(env.AWS_WEB_IDENTITY_TOKEN_FILE).toBeUndefined();
    expect(env.AWS_CONTAINER_AUTHORIZATION_TOKEN).toBeUndefined();
  });

  test.each([
    ["ExpiredToken: please run aws login", "authentication"],
    ["Error loading login credentials: refresh token expired", "authentication"],
    ["Could not connect to the endpoint URL", "network"],
    ["SSL validation failed", "network"],
    ["The config profile (source) could not be found", "configuration"],
    ["AccessDenied: not authorized", "command"],
  ])("classifies %s as %s without exposing stderr or stdout", async (diagnostic, kind) => {
    await bridge.checkVersion();
    native.execFile.mockImplementation((_exe: string, _args: string[], _opts: any, cb: any) =>
      cb({ code: 255, message: "secret-output" }, "secret-stdout", `${diagnostic} https://secret-auth-url`)
    );
    let caught: any;
    try {
      await bridge.command(["configure"]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AwsCliLoginError);
    expect(caught.kind).toBe(kind);
    expect(`${caught.stack} ${JSON.stringify(caught)}`).not.toMatch(/secret-output|secret-stdout|secret-auth-url/);
  });

  test("Terminal launch is not authentication completion; successful exit is required", async () => {
    await bridge.checkVersion();
    jest.useFakeTimers();
    let completed = false;
    const lease = { directory: "/lease", id: "test", assertCurrent: jest.fn() };
    const pending = bridge.login("source", lease, "eu-west-1").then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    const invocation = native.execFile.mock.calls.find((call: any[]) => call[0] === "/usr/bin/osascript");
    expect(invocation[1][1]).toContain("Terminal");
    expect(invocation[1][1]).toContain("/lease/test.sh");
    expect(files.get("/lease/test.sh")).toContain("/dev/tty");
    expect(files.get("/lease/test.sh")).toContain("--region 'eu-west-1'");
    expect(files.get("/lease/test.sh")).not.toContain("& leapp_login_pid");
    expect(invocation[1][1].indexOf("do script")).toBeLessThan(invocation[1][1].indexOf("activate"));
    files.set("/lease/test.result", "0");
    jest.advanceTimersByTime(500);
    await pending;
    expect(completed).toBe(true);
    jest.useRealTimers();
  });

  test("Terminal exit failure is explicit and credentials are never inferred from launch", async () => {
    await bridge.checkVersion();
    files.set("/lease/test.result", "130");
    await expect(bridge.login("source", { directory: "/lease", id: "test", assertCurrent: () => undefined }, "eu-west-1")).rejects.toThrow(
      "did not complete"
    );
  });

  test("interactive command quotes profile and override values and removes terminal credential variables", async () => {
    native.process.env = {
      AWS_CONFIG_FILE: "/config/with 'quote",
      AWS_LOGIN_CACHE_DIRECTORY: "/cache location",
      AWS_SECRET_ACCESS_KEY: "never-forward",
      HTTPS_PROXY: "https://proxy-user:private-proxy-password@proxy.example",
    };
    await bridge.checkVersion();
    files.set("/lease/test.result", "0");
    await bridge.login("source'quoted", { directory: "/lease", id: "test", assertCurrent: () => undefined }, "eu-west-1");
    const terminal = native.execFile.mock.calls.find((call: any[]) => call[0] === "/usr/bin/osascript")[1][1];
    const script = files.get("/lease/test.sh");
    expect(script).toContain("-u AWS_SECRET_ACCESS_KEY");
    expect(script).toContain("AWS_CONFIG_FILE=");
    expect(script).toContain("AWS_LOGIN_CACHE_DIRECTORY=");
    expect(script).not.toContain("never-forward");
    expect(script).not.toContain("eval");
    expect(script).toContain("private-proxy-password");
    expect(terminal).not.toContain("private-proxy-password");
    expect(terminal).not.toContain("AWS_CONFIG_FILE");
    expect(terminal).not.toContain("source'quoted");
    expect(native.fs.writeFileSync).toHaveBeenCalledWith("/lease/test.sh", script, { mode: 0o600, flag: "wx" });
  });

  (process.platform === "darwin" ? test : test.skip)("login script retains a usable terminal and interrupt handling", async () => {
    const fs = require("fs");
    fs.mkdirSync(path.resolve(".cache"), { recursive: true });
    const directory = fs.mkdtempSync(path.resolve(".cache", "aws-cli-login-tty-"));
    try {
      const executable = path.join(directory, "mock-aws");
      fs.writeFileSync(
        executable,
        "#!/bin/sh\n[ -t 0 ] && [ -t 1 ] && [ -t 2 ] || exit 91\n/bin/stty -g >/dev/null || exit 92\n" +
          "printf 'TTY_READY\\n'\nIFS= read -r reply || exit 94\n[ \"$reply\" = test-reply ] || exit 95\n" +
          "trap 'exit 130' INT\nprintf 'INT_READY\\n'\nIFS= read -r ignored\nexit 93\n",
        { mode: 0o700 }
      );
      native.fs = fs;
      (bridge as any).executable = executable;
      fs.writeFileSync(path.join(directory, "lease"), "test");
      fs.writeFileSync(path.join(directory, "test.result"), "0");
      await bridge.login("source", { directory, id: "test", assertCurrent: () => undefined }, "eu-west-1");
      fs.unlinkSync(path.join(directory, "test.result"));
      const terminal = [
        "import errno, os, pty, signal, sys",
        "pid, fd = pty.fork()",
        "if pid == 0:",
        "    os.execv('/bin/sh', ['/bin/sh', sys.argv[1]])",
        "os.write(fd, b'test-reply\\n')",
        "output = b''",
        "interrupted = False",
        "while True:",
        "    try:",
        "        data = os.read(fd, 4096)",
        "    except OSError as error:",
        "        if error.errno == errno.EIO:",
        "            break",
        "        raise",
        "    if not data:",
        "        break",
        "    sys.stdout.buffer.write(data)",
        "    output += data",
        "    if not interrupted and b'INT_READY' in output:",
        "        os.kill(pid, signal.SIGINT)",
        "        with open(sys.argv[2]) as child:",
        "            os.kill(int(child.read()), signal.SIGINT)",
        "        interrupted = True",
        "os.close(fd)",
        "os.waitpid(pid, 0)",
      ].join("\n");
      const result = require("child_process").spawnSync(
        "/usr/bin/python3",
        ["-c", terminal, path.join(directory, "test.sh"), path.join(directory, "test.child")],
        {
          encoding: "utf8",
          timeout: 10000,
        }
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("TTY_READY");
      expect(fs.readFileSync(path.join(directory, "test.result"), "utf8")).toBe("130");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("cancel invalidates in-flight and already-waiting leases across bridge instances", async () => {
    const second = new AwsCliLoginBridge(native);
    const token = bridge.cancellationToken("source");
    await bridge.withLock(
      "source",
      async (lease) => {
        second.cancel("source");
        expect(() => lease.assertCurrent()).toThrow("cancelled");
      },
      () => false
    );
    await expect(
      bridge.withLock(
        "source",
        async () => "late",
        () => false,
        token
      )
    ).rejects.toMatchObject({ kind: "cancelled" });
    expect(native.fs.rmSync).toHaveBeenCalledTimes(1);
  });

  test("serializes concurrent desktop/CLI operations instead of duplicating terminal flows", async () => {
    jest.useFakeTimers();
    let release: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = bridge.withLock(
      "source",
      async () => {
        await gate;
        return "first";
      },
      () => false
    );
    let secondEntered = false;
    const second = new AwsCliLoginBridge(native).withLock(
      "source",
      async () => {
        secondEntered = true;
        return "second";
      },
      () => false
    );
    await Promise.resolve();
    expect(secondEntered).toBe(false);
    release();
    expect(await first).toBe("first");
    jest.advanceTimersByTime(500);
    expect(await second).toBe("second");
    jest.useRealTimers();
  });

  test("recovers a lock whose owning Leapp process has exited", async () => {
    native.process.kill.mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    const directory = (bridge as any).lockDirectory("source");
    directories.add(directory);
    files.set(path.join(directory, "owner"), "999");
    await expect(
      bridge.withLock(
        "source",
        async () => "recovered",
        () => false
      )
    ).resolves.toBe("recovered");
    expect(native.fs.rmSync).toHaveBeenCalledTimes(2);
  });

  test("Stop signals only the recorded child pid and preserves unrelated files", async () => {
    await bridge.withLock(
      "source",
      async (lease) => {
        files.set(path.join(lease.directory, `${lease.id}.child`), "456");
        files.set("/unrelated", "untouched");
        bridge.cancel("source");
        expect(native.process.kill).toHaveBeenCalledWith(456, "SIGTERM");
      },
      () => false
    );
    expect(files.get("/unrelated")).toBe("untouched");
  });

  test("a delayed Terminal command cannot execute login after Stop, even when its directory is reused", async () => {
    const fs = require("fs");
    const fixture = path.resolve(".cache", `aws-cli-login-lease-${native.crypto.randomBytes(8).toString("hex")}`);
    fs.mkdirSync(fixture, { recursive: true });
    native.fs = fs;
    native.os.homedir = () => fixture;
    (bridge as any).executable = "/bin/echo";
    let directory: string;
    let id: string;
    let script: string;
    try {
      await bridge.withLock(
        "source",
        async (lease) => {
          directory = lease.directory;
          id = lease.id;
          fs.writeFileSync(path.join(directory, `${id}.result`), "0");
          await bridge.login("source", lease, "eu-west-1");
          script = fs.readFileSync(path.join(directory, `${id}.sh`), "utf8");
          expect(fs.statSync(path.join(directory, `${id}.sh`)).mode % 0o10000).toBe(0o600);
          fs.unlinkSync(path.join(directory, `${id}.result`));
          bridge.cancel("source");
        },
        () => false
      );
      const appleScript = native.execFile.mock.calls.find((call: any[]) => call[0] === "/usr/bin/osascript")[1][1];
      const terminalCommand = JSON.parse(/do script (.+)\n/.exec(appleScript)[1]);
      const executeQueued = () => require("child_process").spawnSync("/bin/sh", ["-c", terminalCommand], { encoding: "utf8" });
      // /bin/echo stands in for AWS: any execution would print the login arguments.
      expect(fs.existsSync(path.join(directory, `${id}.sh`))).toBe(false);
      expect(executeQueued().stdout).toBe("");
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "lease"), "different-lease");
      fs.writeFileSync(path.join(directory, `${id}.sh`), script.replace(" < /dev/tty", " < /dev/null"), { mode: 0o600 });
      const result = executeQueued();
      expect(result.stdout).toBe("");
      expect(fs.readFileSync(path.join(directory, `${id}.result`), "utf8")).toBe("130");
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
