/* eslint-disable @typescript-eslint/naming-convention -- Test fixtures use AWS CLI JSON, environment, and INI schemas. */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { plainToClass } from "class-transformer";
import { AwsCliLoginSession } from "../../../models/aws/aws-cli-login-session";
import { CredentialsInfo } from "../../../models/credentials-info";
import { Session } from "../../../models/session";
import { SessionStatus } from "../../../models/session-status";
import { SessionType } from "../../../models/session-type";
import { constants } from "../../../models/constants";
import { AwsCliLoginBridge, AwsCliLoginError } from "../../aws-cli-login-bridge";
import { AwsCliLoginService } from "./aws-cli-login-service";

describe("AwsCliLoginService", () => {
  let service: AwsCliLoginService;
  let session: AwsCliLoginSession;
  let sessions: any[];
  let files: { [path: string]: any };
  let repository: any;
  let fileService: any;
  let native: any;
  let notifier: any;
  let command: any;
  let login: any;
  let lease: any;
  let expiration: string;
  const request = { sessionName: "Login", region: "us-east-1", sourceProfile: "source", profileId: "destination" };
  const clone = (value: any) => JSON.parse(JSON.stringify(value));
  const authenticationError = () => new AwsCliLoginError("authentication", "Login expired");

  beforeEach(() => {
    jest.restoreAllMocks();
    expiration = new Date(Date.now() + 3600000).toISOString();
    session = new AwsCliLoginSession(request.sessionName, request.region, request.profileId, request.sourceProfile);
    sessions = [session];
    files = { "/fake/config": { "profile source": { login_session: "source-login" } }, "/fake/credentials": {} };
    repository = {
      getSessions: () => sessions,
      getSessionById: (id: string) => sessions.find((item) => item.sessionId === id),
      getProfileName: (id: string) => id,
      getWorkspace: () => ({ credentialMethod: constants.credentialFile }),
      addSession: jest.fn((item: Session) => sessions.push(item)),
      updateSessions: jest.fn(),
      updateSession: jest.fn(),
      deleteSession: jest.fn(),
    };
    fileService = {
      existsSync: (path: string) => Object.prototype.hasOwnProperty.call(files, path),
      iniParseSync: jest.fn((path: string) => clone(files[path])),
      iniWriteSync: jest.fn(async (path: string, value: any) => {
        files[path] = { ...files[path], ...clone(value) };
      }),
      replaceWriteSync: jest.fn(async (path: string, value: any) => {
        files[path] = clone(value);
      }),
    };
    native = {
      process: { env: {} },
      path: require("path"),
      fs: {
        mkdirSync: jest.fn(),
        chmodSync: jest.fn(),
        writeFileSync: jest.fn((path: string) => {
          files[path] = {};
        }),
      },
    };
    notifier = { setSessions: jest.fn() };
    service = new AwsCliLoginService(
      notifier,
      repository,
      native,
      fileService,
      {
        awsConfigPath: () => "/fake/config",
        awsCredentialPath: () => "/fake/credentials",
      } as any,
      { log: jest.fn() } as any
    );
    jest.spyOn(AwsCliLoginBridge.prototype, "checkVersion").mockResolvedValue(undefined);
    jest.spyOn(AwsCliLoginBridge.prototype, "cancellationToken").mockReturnValue("");
    jest.spyOn(AwsCliLoginBridge.prototype, "cancel").mockImplementation(() => undefined);
    jest.spyOn(AwsCliLoginBridge.prototype, "withLock").mockImplementation(async (_source, action, cancelled) => {
      lease = {
        directory: "/fake/lock",
        assertCurrent: () => {
          if (cancelled()) {
            throw new AwsCliLoginError("cancelled", "Cancelled");
          }
        },
      };
      return action(lease);
    });
    command = jest.spyOn(AwsCliLoginBridge.prototype, "command").mockImplementation(async (args) => {
      if (args[0] === "configure") {
        return JSON.stringify({
          Version: 1,
          AccessKeyId: "test-access",
          SecretAccessKey: "test-secret",
          SessionToken: "test-token",
          Expiration: expiration,
        });
      }
      if (args[0] === "sts") {
        return JSON.stringify({ Account: "123456789012", Arn: "arn:aws:iam::123456789012:user/example" });
      }
      return "";
    });
    login = jest.spyOn(AwsCliLoginBridge.prototype, "login").mockImplementation(async () => {
      files["/fake/config"]["profile source"] = { login_session: "source-login" };
    });
  });

  test("creates a new source without modifying AWS configuration", async () => {
    sessions = [];
    delete files["/fake/config"]["profile source"];
    await service.create(request);
    expect(sessions[0]).toMatchObject({ type: SessionType.awsCliLogin, sourceProfile: "source", profileId: "destination" });
    expect(fileService.iniWriteSync).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  });

  test("identifies the conflicting destination without exposing its values", async () => {
    sessions = [];
    files["/fake/config"]["profile destination"] = { credential_process: "private-existing-command" };
    await expect(service.create(request)).rejects.toThrow(
      'The destination profile "destination" contains configuration not owned by this AWS CLI Login session. Select a new, empty destination profile.'
    );
    expect(repository.addSession).not.toHaveBeenCalled();
    expect(fileService.iniWriteSync).not.toHaveBeenCalled();
  });

  test("reuses a valid login, resolves identity, and publishes only to destination", async () => {
    const sourceBefore = clone(files["/fake/config"]);
    await service.start(session.sessionId);
    expect(login).not.toHaveBeenCalled();
    expect(command.mock.calls[0][0]).toEqual([
      "configure",
      "export-credentials",
      "--profile",
      "source",
      "--region",
      "us-east-1",
      "--format",
      "process",
    ]);
    expect(command.mock.calls[1][1]).toMatchObject({
      AWS_ACCESS_KEY_ID: "test-access",
      AWS_SECRET_ACCESS_KEY: "test-secret",
      AWS_SESSION_TOKEN: "test-token",
    });
    expect(session).toMatchObject({
      status: SessionStatus.active,
      sessionTokenExpiration: expiration,
      principalArn: "arn:aws:iam::123456789012:user/example",
      awsAccount: { accountId: "123456789012" },
    });
    expect(files["/fake/credentials"].destination).toMatchObject({ aws_access_key_id: "test-access", leapp_session_id: session.sessionId });
    expect(files["/fake/config"]).toEqual(sourceBefore);
    expect(JSON.stringify(session)).not.toContain("test-secret");
  });

  test("new source and expired login automatically authenticate before publication", async () => {
    delete files["/fake/config"]["profile source"];
    await service.start(session.sessionId);
    expect(login).toHaveBeenCalledTimes(1);
    expect(login).toHaveBeenCalledWith("source", expect.objectContaining({ directory: "/fake/lock" }), "us-east-1");
    expect(session.status).toBe(SessionStatus.active);
    command.mockRejectedValueOnce(authenticationError());
    await service.rotate(session.sessionId);
    expect(login).toHaveBeenCalledTimes(2);
    expect(session.status).toBe(SessionStatus.active);
  });

  test("only a missing new source profile is treated as an interactive setup request", async () => {
    delete files["/fake/config"]["profile source"];
    const missing = new AwsCliLoginError("configuration", "Profile not found");
    missing.profileMissing = true;
    command.mockRejectedValueOnce(missing);
    await service.start(session.sessionId);
    expect(login).toHaveBeenCalledTimes(1);
    expect(session.status).toBe(SessionStatus.active);
    command.mockRejectedValueOnce(missing);
    await expect(service.rotate(session.sessionId)).rejects.toMatchObject({ kind: "configuration" });
    expect(login).toHaveBeenCalledTimes(1);
  });

  test("expired exported credentials trigger one reauthentication before publication", async () => {
    command.mockResolvedValueOnce(
      JSON.stringify({
        Version: 1,
        AccessKeyId: "a",
        SecretAccessKey: "b",
        SessionToken: "c",
        Expiration: new Date(Date.now() - 1000).toISOString(),
      })
    );
    await service.start(session.sessionId);
    expect(login).toHaveBeenCalledTimes(1);
    expect(session.status).toBe(SessionStatus.active);
  });

  test.each(["network", "configuration", "command"] as const)("never opens a login for %s failures", async (kind) => {
    command.mockRejectedValueOnce(new AwsCliLoginError(kind, "Sanitized failure"));
    await expect(service.start(session.sessionId)).rejects.toMatchObject({ kind });
    expect(login).not.toHaveBeenCalled();
    expect(session.status).toBe(SessionStatus.inactive);
    expect(fileService.iniWriteSync).not.toHaveBeenCalled();
  });

  test.each([constants.credentialFile, constants.credentialProcess])(
    "failed refresh removes owned outputs in %s mode and preserves the export failure",
    async (method) => {
      repository.getWorkspace = () => ({ credentialMethod: method });
      await service.start(session.sessionId);
      files["/fake/credentials"].unrelated = { aws_access_key_id: "external" };
      files["/fake/config"]["profile unrelated"] = { region: "eu-west-1" };
      const failure = new AwsCliLoginError("network", "Network connection failed");
      command.mockRejectedValueOnce(failure);
      await expect(service.rotate(session.sessionId)).rejects.toBe(failure);
      expect(session.status).toBe(SessionStatus.inactive);
      expect(session.sessionTokenExpiration).toBeUndefined();
      expect(files["/fake/credentials"].destination).toBeUndefined();
      expect(files["/fake/config"]["profile destination"]).toBeUndefined();
      expect(files["/fake/credentials"].unrelated).toEqual({ aws_access_key_id: "external" });
      expect(files["/fake/config"]["profile unrelated"]).toEqual({ region: "eu-west-1" });
      expect(files["/fake/config"]["profile source"]).toEqual({ login_session: "source-login" });
      expect(command.mock.calls.some((call: any[]) => call[0][0] === "logout")).toBe(false);
    }
  );

  test.each(["authentication", "cancelled"] as const)(
    "rejected reauthentication (%s) removes stale output and does not reopen Terminal on later timer ticks",
    async (kind) => {
      await service.start(session.sessionId);
      command.mockRejectedValueOnce(authenticationError());
      const failure = new AwsCliLoginError(kind, "Terminal login did not complete");
      login.mockRejectedValueOnce(failure);
      await expect(service.rotate(session.sessionId)).rejects.toBe(failure);
      expect(files["/fake/credentials"].destination).toBeUndefined();
      expect(session.status).toBe(SessionStatus.inactive);
      await service.rotate(session.sessionId);
      await service.rotate(session.sessionId);
      expect(login).toHaveBeenCalledTimes(1);
    }
  );

  test("reports cleanup failure alongside the original refresh error and still attempts both files", async () => {
    await service.start(session.sessionId);
    files["/fake/config"]["profile destination"] = { leapp_session_id: session.sessionId, credential_process: "owned" };
    command.mockRejectedValueOnce(new AwsCliLoginError("network", "Network connection failed"));
    fileService.replaceWriteSync.mockRejectedValueOnce(new Error("secret-internal-file-error"));
    let failure: Error;
    try {
      await service.rotate(session.sessionId);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ kind: "network" });
    expect(failure.message).toContain("Network connection failed");
    expect(failure.message).toContain("Destination cleanup incomplete");
    expect(failure.message).toContain("credential-file entry");
    expect(failure.message).not.toContain("secret-internal-file-error");
    expect(files["/fake/config"]["profile destination"]).toBeUndefined();
    expect(session.status).toBe(SessionStatus.inactive);
  });

  test("publication failure cleans an entry written before a subsequent permissions error", async () => {
    native.fs.chmodSync.mockImplementationOnce(() => {
      throw new Error("private-filesystem-error");
    });
    await expect(service.start(session.sessionId)).rejects.toThrow("AWS CLI Login operation failed");
    expect(files["/fake/credentials"].destination).toBeUndefined();
    expect(session.status).toBe(SessionStatus.inactive);
    expect(session.sessionTokenExpiration).toBeUndefined();
  });

  test("does not mark active on malformed export JSON, missing credentials, or real expiration", async () => {
    for (const result of [
      "not json",
      "null",
      "[]",
      "42",
      "{}",
      JSON.stringify({ Version: 1, AccessKeyId: "x", SecretAccessKey: "y", SessionToken: "z", Expiration: "2000-01-01" }),
    ]) {
      command.mockResolvedValueOnce(result);
      if (result.includes("2000-01-01")) {
        command.mockResolvedValueOnce(result);
      }
      await expect(service.start(session.sessionId)).rejects.toThrow();
      expect(session.status).toBe(SessionStatus.inactive);
    }
    expect(fileService.iniWriteSync).not.toHaveBeenCalled();
  });

  test("rejects invalid identity without publishing credentials", async () => {
    command.mockImplementation(async (args) =>
      args[0] === "sts"
        ? "{}"
        : JSON.stringify({
            Version: 1,
            AccessKeyId: "a",
            SecretAccessKey: "b",
            SessionToken: "c",
            Expiration: expiration,
          })
    );
    await expect(service.start(session.sessionId)).rejects.toThrow("caller identity");
    expect(fileService.iniWriteSync).not.toHaveBeenCalled();
  });

  test("updates selected identity during refresh without a confirmation", async () => {
    await service.start(session.sessionId);
    command.mockImplementation(async (args) =>
      args[0] === "sts"
        ? JSON.stringify({ Account: "210987654321", Arn: "arn:aws:sts::210987654321:assumed-role/new/session" })
        : JSON.stringify({ Version: 1, AccessKeyId: "new", SecretAccessKey: "secret", SessionToken: "token", Expiration: expiration })
    );
    await service.rotate(session.sessionId);
    expect(session.awsAccount.accountId).toBe("210987654321");
    expect(session.principalArn).toContain("assumed-role/new");
    expect(files["/fake/credentials"].destination.aws_access_key_id).toBe("new");
  });

  test("coalesces starts and rotation; Stop cancels pending login and prevents late publication", async () => {
    let release: () => void;
    let reached: () => void;
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    delete files["/fake/config"]["profile source"];
    login.mockImplementation(async () => {
      reached();
      await gate;
    });
    const start = service.start(session.sessionId);
    const startFailure = expect(start).rejects.toMatchObject({ kind: "cancelled" });
    await entered;
    const rotation = service.rotate(session.sessionId);
    const rotateFailure = expect(rotation).rejects.toMatchObject({ kind: "cancelled" });
    expect(login).toHaveBeenCalledTimes(1);
    const stop = service.stop(session.sessionId);
    release();
    await Promise.all([stop, startFailure, rotateFailure]);
    expect(session.status).toBe(SessionStatus.inactive);
    expect(fileService.iniWriteSync).not.toHaveBeenCalled();
    expect(command).toHaveBeenCalledWith(["logout", "--profile", "source"]);
  });

  test("process-mode Start verifies login; generate is noninteractive and returns only process credentials", async () => {
    repository.getWorkspace = () => ({ credentialMethod: constants.credentialProcess });
    await service.start(session.sessionId);
    expect(session.status).toBe(SessionStatus.active);
    expect(files["/fake/config"]["profile destination"].credential_process).toBe(`leapp session generate ${session.sessionId}`);
    expect(files["/fake/credentials"].destination).toBeUndefined();
    const process = await service.generateProcessCredentials(session.sessionId);
    expect(JSON.parse(JSON.stringify(process))).toEqual({
      Version: 1,
      AccessKeyId: "test-access",
      SecretAccessKey: "test-secret",
      SessionToken: "test-token",
      Expiration: expiration,
    });
    command.mockRejectedValueOnce(authenticationError());
    await expect(service.generateProcessCredentials(session.sessionId)).rejects.toMatchObject({ kind: "authentication" });
    expect(login).not.toHaveBeenCalled();
  });

  test("process-mode rotation reauthenticates only through the active lifecycle", async () => {
    repository.getWorkspace = () => ({ credentialMethod: constants.credentialProcess });
    await service.start(session.sessionId);
    command.mockRejectedValueOnce(authenticationError());
    await service.rotate(session.sessionId);
    expect(login).toHaveBeenCalledTimes(1);
    expect(session.status).toBe(SessionStatus.active);
  });

  test("switching file to process and back removes opposite-mode owned output without changing source or unrelated profiles", async () => {
    let method = constants.credentialFile;
    repository.getWorkspace = () => ({ credentialMethod: method });
    files["/fake/config"]["profile unrelated"] = { credential_process: "external-command" };
    files["/fake/credentials"].unrelated = { aws_access_key_id: "external" };
    const source = clone(files["/fake/config"]["profile source"]);
    await service.start(session.sessionId);
    expect(files["/fake/credentials"].destination).toBeDefined();
    method = constants.credentialProcess;
    await service.rotate(session.sessionId);
    expect(files["/fake/credentials"].destination).toBeUndefined();
    expect(files["/fake/config"]["profile destination"].credential_process).toBe(`leapp session generate ${session.sessionId}`);
    method = constants.credentialFile;
    await service.rotate(session.sessionId);
    expect(files["/fake/config"]["profile destination"]).toBeUndefined();
    expect(files["/fake/credentials"].destination.aws_access_key_id).toBe("test-access");
    expect(files["/fake/config"]["profile source"]).toEqual(source);
    expect(files["/fake/config"]["profile unrelated"]).toEqual({ credential_process: "external-command" });
    expect(files["/fake/credentials"].unrelated).toEqual({ aws_access_key_id: "external" });
    expect(session.status).toBe(SessionStatus.active);
  });

  test("Stop cleans only owned entries and logs out; repeated Stop retries failures explicitly", async () => {
    await service.start(session.sessionId);
    files["/fake/credentials"].unrelated = { aws_access_key_id: "untouched" };
    command.mockRejectedValueOnce(new AwsCliLoginError("network", "Network unavailable"));
    await expect(service.stop(session.sessionId)).rejects.toThrow("partial failure");
    expect(files["/fake/credentials"]).toEqual({ unrelated: { aws_access_key_id: "untouched" } });
    expect(files["/fake/config"]["profile source"].login_session).toBe("source-login");
    expect(session.status).toBe(SessionStatus.inactive);
    await service.stop(session.sessionId);
    expect(command.mock.calls.filter((call: any[]) => call[0][0] === "logout")).toHaveLength(2);
  });

  test("Stop independently attempts both cleanup files and logout after cleanup failure", async () => {
    await service.start(session.sessionId);
    files["/fake/config"]["profile destination"] = { leapp_session_id: session.sessionId, credential_process: "owned" };
    fileService.replaceWriteSync.mockRejectedValueOnce(new Error("permission denied"));
    await expect(service.stop(session.sessionId)).rejects.toThrow("partial failure");
    expect(files["/fake/config"]["profile destination"]).toBeUndefined();
    expect(command).toHaveBeenCalledWith(["logout", "--profile", "source"]);
  });

  test("never removes externally replaced destinations", async () => {
    files["/fake/credentials"].destination = { aws_access_key_id: "external" };
    files["/fake/config"]["profile destination"] = { credential_process: "external" };
    await service.stop(session.sessionId);
    expect(files["/fake/credentials"].destination.aws_access_key_id).toBe("external");
    expect(files["/fake/config"]["profile destination"].credential_process).toBe("external");
  });

  test.each([{ sourceProfile: "destination" }, { sourceProfile: "invalid\nprofile" }, { sourceProfile: "source;echo" }, { sessionName: "" }])(
    "rejects invalid request %p",
    async (overrides) => {
      sessions = [];
      await expect(service.create({ ...request, ...overrides })).rejects.toThrow();
      expect(repository.addSession).not.toHaveBeenCalled();
    }
  );

  test("rejects duplicate sources, another session's output, inverse source collisions and unmanaged destination config", async () => {
    await expect(service.create({ ...request, profileId: "other" })).rejects.toThrow("already uses");
    await expect(service.create({ ...request, sourceProfile: "destination", profileId: "other" })).rejects.toThrow("output");
    await expect(service.create({ ...request, sourceProfile: "new", profileId: "source" })).rejects.toThrow("another");
    sessions = [];
    files["/fake/config"]["profile destination"] = { role_arn: "do not overwrite" };
    await expect(service.create(request)).rejects.toThrow("not owned");
  });

  test("does not overwrite IAM, role, SSO, process or region-only source profiles", async () => {
    sessions = [];
    for (const config of [
      { region: "us-east-1" },
      { role_arn: "role" },
      { sso_session: "sso" },
      { credential_process: "command" },
      { login_session: "source", source_profile: "another" },
    ]) {
      files["/fake/config"]["profile source"] = config;
      await expect(service.create(request)).rejects.toThrow("not a dedicated");
    }
    files["/fake/config"]["profile source"] = { login_session: "login" };
    files["/fake/credentials"].source = { aws_access_key_id: "old" };
    await expect(service.create(request)).rejects.toThrow("shared credentials");
  });

  test("accepts and preserves ordinary login-profile settings while refusing conflicting credential providers", async () => {
    const source = {
      login_session: "source-login",
      ca_bundle: "/custom/ca",
      retry_mode: "adaptive",
      cli_pager: "",
      endpoint_url: "https://endpoint.example",
      max_attempts: 4,
    };
    files["/fake/config"]["profile source"] = clone(source);
    await service.start(session.sessionId);
    expect(files["/fake/config"]["profile source"]).toEqual(source);
    sessions = [];
    for (const key of [
      "credential_process",
      "credential_source",
      "role_arn",
      "source_profile",
      "sso_session",
      "web_identity_token_file",
      "aws_access_key_id",
    ]) {
      files["/fake/config"]["profile source"] = { ...source, [key]: "conflicting" };
      await expect(service.create({ ...request, profileId: "different-destination" })).rejects.toThrow("not a dedicated");
    }
  });

  test("honors config/credentials overrides without reading default locations", async () => {
    native.process.env = { AWS_CONFIG_FILE: "/override/config", AWS_SHARED_CREDENTIALS_FILE: "/override/credentials" };
    files["/override/config"] = files["/fake/config"];
    await service.start(session.sessionId);
    expect(files["/override/credentials"].destination.aws_access_key_id).toBe("test-access");
    expect(files["/fake/credentials"]).toEqual({});
    expect(fileService.iniParseSync.mock.calls.every((call: any[]) => call[0].startsWith("/override/"))).toBe(true);
  });

  test("rejects config/credential file aliasing rather than corrupting profile sections", async () => {
    native.process.env = { AWS_CONFIG_FILE: "/same-file", AWS_SHARED_CREDENTIALS_FILE: "/same-file" };
    await expect(service.start(session.sessionId)).rejects.toThrow("files must be separate");
    expect(command).not.toHaveBeenCalled();
  });

  test("blocks console for IAM users and unverified roles without federation calls", async () => {
    const credentials: CredentialsInfo = await service.generateCredentials(session.sessionId);
    expect(credentials.consoleUnsupportedReason).toContain("IAM-user");
    expect(() => service.assertConsoleSupported(session)).toThrow("IAM-user");
    session.principalArn = "arn:aws:sts::123456789012:assumed-role/role/session";
    expect(() => service.assertConsoleSupported(session)).toThrow("not been verified");
  });

  test("persistence with base Session hydration retains source, destination and identity metadata", async () => {
    await service.start(session.sessionId);
    const hydrated = plainToClass(Session, JSON.parse(JSON.stringify(session))) as AwsCliLoginSession;
    expect(hydrated).toBeInstanceOf(Session);
    expect(hydrated).not.toBeInstanceOf(AwsCliLoginSession);
    sessions = [hydrated];
    await service.rotate(hydrated.sessionId);
    expect(hydrated.status).toBe(SessionStatus.active);
    expect(hydrated.sourceProfile).toBe("source");
    expect(hydrated.principalArn).toContain(":user/");
  });

  test("editing an active session switches destinations safely and retains its id", async () => {
    await service.start(session.sessionId);
    const id = session.sessionId;
    await service.update(id, { ...request, profileId: "new-destination", sessionName: "Renamed" });
    expect(files["/fake/credentials"].destination).toBeUndefined();
    expect(files["/fake/credentials"]["new-destination"].leapp_session_id).toBe(id);
    expect(session).toMatchObject({ sessionId: id, sessionName: "Renamed", status: SessionStatus.active });
  });

  test("destination switching stops another session using its actual service", async () => {
    const other = { sessionId: "other", profileId: "destination", type: SessionType.awsIamUser, status: SessionStatus.active };
    sessions.push(other);
    files["/fake/credentials"].destination = { aws_access_key_id: "other-session" };
    const stop = jest.fn(async () => {
      delete files["/fake/credentials"].destination;
      other.status = SessionStatus.inactive;
    });
    service.setSessionServiceResolver(() => ({ stop } as any));
    await service.start(session.sessionId);
    expect(stop).toHaveBeenCalledWith("other");
    expect(session.status).toBe(SessionStatus.active);
  });

  test("delete retains session on logout failure and does not claim success", async () => {
    command.mockRejectedValueOnce(new AwsCliLoginError("network", "Network unavailable"));
    await expect(service.delete(session.sessionId)).rejects.toThrow("partial failure");
    expect(repository.deleteSession).not.toHaveBeenCalled();
    await service.delete(session.sessionId);
    expect(repository.deleteSession).toHaveBeenCalledWith(session.sessionId);
  });

  test("sanitizes INI parser errors without exposing credentials", async () => {
    fileService.iniParseSync.mockImplementation(() => {
      throw new Error("secret=private-config-value");
    });
    await expect(service.start(session.sessionId)).rejects.toThrow("INI syntax");
    await expect(service.start(session.sessionId)).rejects.not.toThrow("private-config-value");
  });
});
