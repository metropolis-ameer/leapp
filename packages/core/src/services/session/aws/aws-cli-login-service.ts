import { IBehaviouralNotifier } from "../../../interfaces/i-behavioural-notifier";
import { INativeService } from "../../../interfaces/i-native-service";
import { AwsCliLoginSession } from "../../../models/aws/aws-cli-login-session";
import { CredentialsInfo } from "../../../models/credentials-info";
import { Session } from "../../../models/session";
import { SessionStatus } from "../../../models/session-status";
import { SessionType } from "../../../models/session-type";
import { constants } from "../../../models/constants";
import { AwsCliLoginBridge, AwsCliLoginError, AwsCliLoginLease } from "../../aws-cli-login-bridge";
import { AwsCoreService } from "../../aws-core-service";
import { FileService } from "../../file-service";
import { LogService } from "../../log-service";
import { Repository } from "../../repository";
import { AwsSessionService } from "./aws-session-service";
import { AwsCliLoginSessionRequest } from "./aws-cli-login-session-request";

/* eslint-disable @typescript-eslint/naming-convention -- AWS CLI JSON schemas define these property names. */
interface AwsCliExportCredentials {
  Version: 1;
  AccessKeyId: string;
  SecretAccessKey: string;
  SessionToken: string;
  Expiration: string;
}

interface AwsCliCallerIdentity {
  Account: string;
  Arn: string;
}
/* eslint-enable @typescript-eslint/naming-convention */

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isCredentialString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && !/[\r\n\0]/.test(value);

export class AwsCliLoginService extends AwsSessionService {
  private bridge: AwsCliLoginBridge;
  private operations = new Map<string, Promise<void>>();
  private generations = new Map<string, number>();

  constructor(
    sessionNotifier: IBehaviouralNotifier,
    repository: Repository,
    private nativeService: INativeService,
    fileService: FileService,
    awsCoreService: AwsCoreService,
    private logService: LogService
  ) {
    super(sessionNotifier, repository, awsCoreService, fileService);
    this.bridge = new AwsCliLoginBridge(nativeService);
  }

  async create(request: AwsCliLoginSessionRequest): Promise<void> {
    this.validateRequest(request);
    this.validateSource(request.sourceProfile);
    const session = new AwsCliLoginSession(request.sessionName.trim(), request.region, request.profileId, request.sourceProfile);
    this.repository.addSession(session);
    this.notify();
  }

  async update(sessionId: string, request: AwsCliLoginSessionRequest): Promise<void> {
    this.validateRequest(request, sessionId);
    this.validateSource(request.sourceProfile);
    const session = this.session(sessionId);
    const restart = session.status === SessionStatus.active;
    if (session.status !== SessionStatus.inactive || this.operations.has(sessionId)) {
      await this.stop(sessionId);
    }
    if (session.sourceProfile !== request.sourceProfile) {
      session.awsAccount = undefined;
      session.principalArn = undefined;
      session.sessionTokenExpiration = undefined;
    }
    session.sessionName = request.sessionName.trim();
    session.region = request.region;
    session.profileId = request.profileId;
    session.sourceProfile = request.sourceProfile;
    this.repository.updateSession(sessionId, session);
    this.notify();
    if (restart) {
      await this.start(sessionId);
    }
  }

  async start(sessionId: string): Promise<void> {
    return this.run(sessionId);
  }

  async rotate(sessionId: string): Promise<void> {
    if (this.session(sessionId).status === SessionStatus.inactive) {
      return;
    }
    return this.run(sessionId);
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.session(sessionId);
    this.generations.set(sessionId, (this.generations.get(sessionId) || 0) + 1);
    this.bridge.cancel(session.sourceProfile);
    const pending = this.operations.get(sessionId);
    if (pending) {
      await pending.catch(() => undefined);
    }
    const failures: string[] = [];
    await this.bridge.withLock(
      session.sourceProfile,
      async () => {
        failures.push(...(await this.cleanupDestination(sessionId)));
        try {
          await this.bridge.checkVersion();
          await this.bridge.command(["logout", "--profile", session.sourceProfile]);
        } catch (error) {
          failures.push(`AWS source logout failed: ${this.safeError(error).message}`);
        }
      },
      () => false
    );
    this.sessionDeactivated(sessionId);
    session.sessionTokenExpiration = undefined;
    this.repository.updateSession(sessionId, session);
    this.notify();
    if (failures.length) {
      throw new Error(
        `AWS CLI Login stopped with partial failure. ${failures.join("; ")}. Retry Stop. Shared AWS login/browser credentials may remain valid.`
      );
    }
  }

  async delete(sessionId: string): Promise<void> {
    await this.stop(sessionId);
    this.repository.deleteSession(sessionId);
    this.notify();
  }

  async generateCredentials(sessionId: string): Promise<CredentialsInfo> {
    const session = this.session(sessionId);
    const cancellationToken = this.bridge.cancellationToken(session.sourceProfile);
    this.validateRequest(session, sessionId);
    this.validateSource(session.sourceProfile);
    await this.bridge.checkVersion();
    const generation = this.generations.get(sessionId) || 0;
    return this.bridge.withLock(
      session.sourceProfile,
      (lease) => this.exportCredentials(session, lease, false),
      () => generation !== (this.generations.get(sessionId) || 0),
      cancellationToken
    );
  }

  generateCredentialsProxy(sessionId: string): Promise<CredentialsInfo> {
    // Credential-process calls must never open interactive windows. Start/rotation owns reauthentication.
    return this.generateCredentials(sessionId);
  }

  async validateCredentials(sessionId: string): Promise<boolean> {
    try {
      await this.generateCredentials(sessionId);
      return true;
    } catch (_) {
      return false;
    }
  }

  async getAccountNumberFromCallerIdentity(session: AwsCliLoginSession): Promise<string> {
    await this.generateCredentials(session.sessionId);
    return this.session(session.sessionId).awsAccount.accountId;
  }

  assertConsoleSupported(session: Session): void {
    throw new Error(this.consoleReason(session as AwsCliLoginSession));
  }

  async applyCredentials(sessionId: string, credentials: CredentialsInfo): Promise<void> {
    const session = this.session(sessionId);
    this.validateRequest(session, sessionId);
    const profile = this.repository.getProfileName(session.profileId);
    const path = this.credentialsPath();
    const current = this.readIni(path);
    this.assertOwnedOrEmpty(current[profile], profile, sessionId);
    this.ensureParent(path);
    await this.fileService.iniWriteSync(path, {
      [profile]: { ...credentials.sessionToken, region: session.region, ["leapp_session_id"]: sessionId },
    });
    this.nativeService.fs.chmodSync(path, 0o600);
  }

  async applyConfigProfileCommand(sessionId: string): Promise<void> {
    const session = this.session(sessionId);
    this.validateRequest(session, sessionId);
    const path = this.configPath();
    const destination = this.repository.getProfileName(session.profileId);
    const profile = this.configSection(destination);
    const current = this.readIni(path);
    this.assertOwnedOrEmpty(current[profile], destination, sessionId);
    this.ensureParent(path);
    await this.fileService.iniWriteSync(path, {
      [profile]: { ["credential_process"]: `leapp session generate ${sessionId}`, region: session.region, ["leapp_session_id"]: sessionId },
    });
    this.nativeService.fs.chmodSync(path, 0o600);
  }

  async deApplyCredentials(sessionId: string): Promise<void> {
    await this.removeOwned(this.credentialsPath(), this.repository.getProfileName(this.session(sessionId).profileId), sessionId);
  }

  async deApplyConfigProfileCommand(sessionId: string): Promise<void> {
    await this.removeOwned(this.configPath(), this.configSection(this.repository.getProfileName(this.session(sessionId).profileId)), sessionId);
  }

  removeSecrets(_: string): void {}

  getDependantSessions(_: string): Session[] {
    return [];
  }

  async getCloneRequest(_session: AwsCliLoginSession): Promise<AwsCliLoginSessionRequest> {
    throw new Error(`AWS CLI Login sessions cannot be cloned: each source profile may belong to only one Leapp session.`);
  }

  private run(sessionId: string): Promise<void> {
    const existing = this.operations.get(sessionId);
    if (existing) {
      return existing;
    }
    const generation = this.generations.get(sessionId) || 0;
    const cancelled = () => (this.generations.get(sessionId) || 0) !== generation;
    const operation = this.activate(sessionId, cancelled).finally(() => {
      if (this.operations.get(sessionId) === operation) {
        this.operations.delete(sessionId);
      }
    });
    this.operations.set(sessionId, operation);
    return operation;
  }

  private async activate(sessionId: string, cancelled: () => boolean): Promise<void> {
    const session = this.session(sessionId);
    let failureHandled = false;
    try {
      const cancellationToken = this.bridge.cancellationToken(session.sourceProfile);
      this.validateRequest(session, sessionId);
      this.validateSource(session.sourceProfile);
      await this.bridge.checkVersion();
      for (const other of this.repository.getSessions()) {
        if (other.sessionId !== sessionId && (other as any).profileId === session.profileId && other.status === SessionStatus.pending) {
          throw new AwsCliLoginError("configuration", "A pending session already uses this destination profile.");
        }
        if (other.sessionId !== sessionId && (other as any).profileId === session.profileId && other.status === SessionStatus.active) {
          if (!this.resolveService) {
            throw new AwsCliLoginError("configuration", "Stop the active session using this destination profile before starting AWS CLI Login.");
          }
          await this.resolveService(other.type).stop(other.sessionId);
        }
      }
      this.sessionLoading(sessionId);
      await this.bridge.withLock(
        session.sourceProfile,
        async (lease) => {
          try {
            const credentials = await this.exportCredentials(session, lease, true);
            lease.assertCurrent();
            if (this.repository.getWorkspace().credentialMethod === constants.credentialFile) {
              await this.deApplyConfigProfileCommand(sessionId);
              await this.applyCredentials(sessionId, credentials);
            } else {
              await this.deApplyCredentials(sessionId);
              await this.applyConfigProfileCommand(sessionId);
            }
            // Publication and cancellation share a lease; Stop waits for it and removes any output.
            lease.assertCurrent();
            this.sessionActivated(sessionId, session.sessionTokenExpiration);
          } catch (error) {
            failureHandled = true;
            await this.activationFailed(sessionId, error, cancelled());
          }
        },
        cancelled,
        cancellationToken
      );
    } catch (error) {
      if (failureHandled) {
        throw error;
      }
      await this.activationFailed(sessionId, error, cancelled());
    }
  }

  private async activationFailed(sessionId: string, error: unknown, cancelled: boolean): Promise<never> {
    const failure = cancelled
      ? new AwsCliLoginError("cancelled", "AWS CLI login was cancelled. No late credentials will be published.")
      : this.safeError(error);
    const cleanupFailures = await this.cleanupDestination(sessionId);
    this.sessionDeactivated(sessionId);
    const session = this.session(sessionId);
    session.sessionTokenExpiration = undefined;
    this.repository.updateSession(sessionId, session);
    this.notify();
    if (cleanupFailures.length) {
      throw new AwsCliLoginError(
        failure instanceof AwsCliLoginError ? failure.kind : "command",
        `${failure.message} Destination cleanup incomplete: ${cleanupFailures.join("; ")}. Retry Stop before using this destination.`
      );
    }
    throw failure;
  }

  private async cleanupDestination(sessionId: string): Promise<string[]> {
    const failures: string[] = [];
    for (const [label, cleanup] of [
      ["credential-file entry", () => this.deApplyCredentials(sessionId)],
      ["credential-process entry", () => this.deApplyConfigProfileCommand(sessionId)],
    ] as const) {
      try {
        await cleanup();
      } catch (_) {
        failures.push(`Leapp-owned ${label} could not be removed; check AWS file permissions and INI syntax`);
      }
    }
    return failures;
  }

  private async exportCredentials(session: AwsCliLoginSession, lease: AwsCliLoginLease, interactive: boolean): Promise<CredentialsInfo> {
    let result: AwsCliExportCredentials;
    const exportCommand = () =>
      this.bridge.command(["configure", "export-credentials", "--profile", session.sourceProfile, "--region", session.region, "--format", "process"]);
    lease.assertCurrent();
    const missingSource = !this.sourceExists(session.sourceProfile);
    try {
      const output = await exportCommand();
      // A new source does not exist until `aws login` creates it. Existing sources must be login profiles.
      if (missingSource) {
        throw new AwsCliLoginError("authentication", "The AWS login source profile has not been created yet.");
      }
      result = this.parseCredentials(output);
    } catch (error) {
      const needsLogin = error instanceof AwsCliLoginError && (error.kind === "authentication" || (error.profileMissing && missingSource));
      if (!needsLogin || !interactive) {
        throw error;
      }
      await this.bridge.login(session.sourceProfile, lease, session.region);
      lease.assertCurrent();
      this.validateSource(session.sourceProfile);
      result = this.parseCredentials(await exportCommand());
    }
    lease.assertCurrent();
    const environment = {
      ...this.bridge.environment(),
      ["AWS_ACCESS_KEY_ID"]: result.AccessKeyId,
      ["AWS_SECRET_ACCESS_KEY"]: result.SecretAccessKey,
      ["AWS_SESSION_TOKEN"]: result.SessionToken,
    };
    const identityOutput = await this.bridge.command(["sts", "get-caller-identity", "--region", session.region, "--output", "json"], environment);
    lease.assertCurrent();
    const identity = this.parseIdentity(identityOutput);
    session.awsAccount = { accountId: identity.Account, accountName: identity.Account };
    session.principalArn = identity.Arn;
    session.sessionTokenExpiration = new Date(result.Expiration).toISOString();
    this.repository.updateSession(session.sessionId, session);
    this.notify();
    return {
      sessionToken: {
        ["aws_access_key_id"]: result.AccessKeyId,
        ["aws_secret_access_key"]: result.SecretAccessKey,
        ["aws_session_token"]: result.SessionToken,
      },
      consoleUnsupportedReason: this.consoleReason(session),
    };
  }

  private parseIdentity(output: string): AwsCliCallerIdentity {
    let identity: unknown;
    try {
      identity = JSON.parse(output);
    } catch (_) {
      throw new AwsCliLoginError("command", "AWS CLI returned invalid caller identity JSON.");
    }
    if (
      !isRecord(identity) ||
      typeof identity.Account !== "string" ||
      !/^\d{12}$/.test(identity.Account) ||
      typeof identity.Arn !== "string" ||
      !/^arn:[^:]+:(iam|sts)::\d{12}:.+/.test(identity.Arn) ||
      identity.Arn.split(":")[4] !== identity.Account
    ) {
      throw new AwsCliLoginError("command", "AWS CLI returned an invalid caller identity. Credentials were not published.");
    }
    return { ["Account"]: identity.Account, ["Arn"]: identity.Arn };
  }

  private parseCredentials(output: string): AwsCliExportCredentials {
    let result: unknown;
    try {
      result = JSON.parse(output);
    } catch (_) {
      throw new AwsCliLoginError("command", "AWS CLI returned invalid credential-process JSON. Upgrade or repair AWS CLI.");
    }
    if (
      !isRecord(result) ||
      result.Version !== 1 ||
      !isCredentialString(result.AccessKeyId) ||
      !isCredentialString(result.SecretAccessKey) ||
      !isCredentialString(result.SessionToken) ||
      typeof result.Expiration !== "string" ||
      !Number.isFinite(Date.parse(result.Expiration))
    ) {
      throw new AwsCliLoginError("command", "AWS CLI returned incomplete temporary credentials or an invalid expiration. Upgrade or repair AWS CLI.");
    }
    if (Date.parse(result.Expiration) <= Date.now()) {
      throw new AwsCliLoginError("authentication", "AWS CLI returned expired temporary credentials. Run Start to authenticate again.");
    }
    return {
      ["Version"]: 1,
      ["AccessKeyId"]: result.AccessKeyId,
      ["SecretAccessKey"]: result.SecretAccessKey,
      ["SessionToken"]: result.SessionToken,
      ["Expiration"]: result.Expiration,
    };
  }

  private validateRequest(request: AwsCliLoginSessionRequest, sessionId?: string): void {
    if (!request.sessionName?.trim() || !request.region?.trim() || !/^[A-Za-z0-9][A-Za-z0-9_.@+-]{0,127}$/.test(request.sourceProfile)) {
      throw new AwsCliLoginError(
        "configuration",
        "AWS CLI Login requires an alias, region, and a source profile using letters, digits, dot, underscore, @, + or hyphen."
      );
    }
    const destination = this.repository.getProfileName(request.profileId);
    if (/[\r\n\0[\]]/.test(destination) || this.configPath() === this.credentialsPath()) {
      throw new AwsCliLoginError(
        "configuration",
        "AWS config and credentials files must be separate, and destination names cannot contain brackets or control characters."
      );
    }
    if (!destination || destination === request.sourceProfile) {
      throw new AwsCliLoginError("configuration", "AWS CLI Login source and Leapp destination profiles must be different.");
    }
    for (const other of this.repository.getSessions()) {
      if (other.sessionId === sessionId) {
        continue;
      }
      const otherProfile = (other as any).profileId;
      if (otherProfile && this.repository.getProfileName(otherProfile) === request.sourceProfile) {
        throw new AwsCliLoginError("configuration", "The AWS login source profile is already used as a Leapp output profile.");
      }
      if (other.type === SessionType.awsCliLogin) {
        const login = other as AwsCliLoginSession;
        if (login.sourceProfile === request.sourceProfile) {
          throw new AwsCliLoginError("configuration", "An AWS CLI Login session already uses this source profile.");
        }
        if (login.sourceProfile === destination) {
          throw new AwsCliLoginError("configuration", "The destination profile is another AWS CLI Login session's source profile.");
        }
      }
    }
    // Validate both files regardless of publication mode: static credentials take priority over credential_process.
    const switchingLeappOutput = this.repository
      .getSessions()
      .some((other) => other.sessionId !== sessionId && (other as any).profileId === request.profileId && other.status === SessionStatus.active);
    if (!switchingLeappOutput) {
      this.assertOwnedOrEmpty(this.readIni(this.credentialsPath())[destination], destination, sessionId);
      this.assertOwnedOrEmpty(this.readIni(this.configPath())[this.configSection(destination)], destination, sessionId);
    }
  }

  private validateSource(source: string): void {
    const credential = this.readIni(this.credentialsPath())[source];
    const profile = this.readIni(this.configPath())[this.configSection(source)];
    if (credential && Object.keys(credential).length) {
      throw new AwsCliLoginError(
        "configuration",
        "The source profile has shared credentials. Choose a dedicated AWS login source; Leapp will not overwrite non-login credentials."
      );
    }
    const conflictingProviderKeys = [
      "credential_process",
      "credential_source",
      "role_arn",
      "source_profile",
      "web_identity_token_file",
      "aws_access_key_id",
      "aws_secret_access_key",
      "aws_session_token",
      "aws_security_token",
    ];
    if (
      profile &&
      (!isCredentialString(profile.login_session) ||
        Object.keys(profile).some((key) => conflictingProviderKeys.includes(key.toLowerCase()) || key.toLowerCase().startsWith("sso_")))
    ) {
      throw new AwsCliLoginError(
        "configuration",
        "The source profile is not a dedicated AWS CLI Login profile. Choose a new source or an existing aws login profile."
      );
    }
  }

  private sourceExists(source: string): boolean {
    return !!this.readIni(this.configPath())[this.configSection(source)]?.login_session;
  }

  private assertOwnedOrEmpty(section: any, profile: string, sessionId?: string): void {
    if (section && Object.keys(section).length && (!sessionId || section.leapp_session_id !== sessionId)) {
      throw new AwsCliLoginError(
        "configuration",
        `The destination profile ${JSON.stringify(
          profile
        )} contains configuration not owned by this AWS CLI Login session. Select a new, empty destination profile.`
      );
    }
  }

  private async removeOwned(path: string, section: string, sessionId: string): Promise<void> {
    const current = this.readIni(path);
    if (current[section]?.leapp_session_id === sessionId) {
      delete current[section];
      await this.fileService.replaceWriteSync(path, current);
    }
  }

  private readIni(path: string): any {
    try {
      return this.fileService.existsSync(path) ? this.fileService.iniParseSync(path) : {};
    } catch (_) {
      throw new AwsCliLoginError("configuration", "Cannot read AWS profile configuration. Check file permissions and INI syntax.");
    }
  }

  private ensureParent(path: string): void {
    this.nativeService.fs.mkdirSync(this.nativeService.path.dirname(path), { recursive: true, mode: 0o700 });
    if (!this.fileService.existsSync(path)) {
      this.nativeService.fs.writeFileSync(path, "", { mode: 0o600 });
    }
  }

  private credentialsPath(): string {
    const override = this.nativeService.process.env.AWS_SHARED_CREDENTIALS_FILE;
    return override ? this.nativeService.path.resolve(override) : this.awsCoreService.awsCredentialPath();
  }

  private configPath(): string {
    const override = this.nativeService.process.env.AWS_CONFIG_FILE;
    return override ? this.nativeService.path.resolve(override) : this.awsCoreService.awsConfigPath();
  }

  private configSection(profile: string): string {
    return profile === "default" ? "default" : `profile ${profile}`;
  }

  private session(sessionId: string): AwsCliLoginSession {
    const session = this.repository.getSessionById(sessionId);
    if (session.type !== SessionType.awsCliLogin) {
      throw new Error("AWS CLI Login session required.");
    }
    return session as AwsCliLoginSession;
  }

  private consoleReason(session: AwsCliLoginSession): string {
    return session.principalArn?.includes(":iam::") && session.principalArn.includes(":user/")
      ? "AWS console unavailable: IAM-user AWS CLI Login credentials do not support the tested federated console login. No additional role assumption is performed."
      : "AWS console unavailable: federated console access for AWS CLI Login identities has not been verified. Use AWS-supported console sign-in separately.";
  }

  private safeError(error: unknown): Error {
    return error instanceof AwsCliLoginError
      ? error
      : new Error("AWS CLI Login operation failed. Check the source/destination configuration and AWS file permissions, then retry.");
  }

  private notify(): void {
    this.sessionNotifier?.setSessions([...this.repository.getSessions()]);
  }
}
