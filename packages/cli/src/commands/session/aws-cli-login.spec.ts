import { describe, expect, jest, test } from "@jest/globals";
import { SessionType } from "@noovolari/leapp-core/models/session-type";
import { AwsSessionService } from "@noovolari/leapp-core/services/session/aws/aws-session-service";
import { ux } from "@oclif/core";
import CurrentSession from "./current";
import GenerateSession from "./generate";
import OpenWebConsole from "./open-web-console";
import StartSsmSession from "./start-ssm-session";
import StartSession from "./start";
import StopSession from "./stop";
import ListSessions from "./list";
import { SessionStatus } from "@noovolari/leapp-core/models/session-status";

const login: any = {
  sessionId: "login-id",
  sessionName: "CLI login",
  type: SessionType.awsCliLogin,
  sourceProfile: "login-source",
  profileId: "destination-id",
  awsAccount: { accountId: "123456789012", accountName: "" },
  principalArn: "arn:aws:iam::123456789012:user/example",
};

describe("AWS CLI Login commands", () => {
  test("start and stop dispatch through the session factory and refresh desktop state", async () => {
    const service = { start: jest.fn(async () => {}), stop: jest.fn(async () => {}) };
    const provider = {
      sessionFactory: { getSessionService: jest.fn(() => service) },
      remoteProceduresClient: { refreshSessions: jest.fn(async () => {}) },
    };
    const start = new StartSession([], {} as any);
    (start as any).cliProviderService = provider;
    start.log = jest.fn();
    await start.startSession(login);
    expect(service.start).toHaveBeenCalledWith("login-id");
    expect(start.log).toHaveBeenCalledWith("session CLI login started");
    const stop = new StopSession([], {} as any);
    (stop as any).cliProviderService = provider;
    stop.log = jest.fn();
    stop.warn = jest.fn();
    await stop.stopSession(login);
    expect(service.stop).toHaveBeenCalledWith("login-id");
    expect(stop.warn).toHaveBeenCalledWith(expect.stringContaining("other tools sharing it"));
    expect(provider.sessionFactory.getSessionService).toHaveBeenCalledWith(SessionType.awsCliLogin);
    expect(provider.remoteProceduresClient.refreshSessions).toHaveBeenCalledTimes(2);
  });

  test("list exposes the source and resolved identity as extended columns", async () => {
    const command = new ListSessions([], {} as any);
    (command as any).cliProviderService = {
      sessionManagementService: { getSessions: () => [login] },
      cloudProviderService: { getSessionTypeMap: () => new Map([[SessionType.awsCliLogin, "AWS CLI Login"]]) },
      namedProfilesService: { getNamedProfilesMap: () => new Map([["destination-id", { name: "destination" }]]) },
    };
    const table = jest.spyOn(ux, "table").mockImplementation(() => null);
    try {
      await command.showSessions();
      expect(table.mock.calls[0][0]).toEqual([
        expect.objectContaining({
          type: "AWS CLI Login",
          profileId: "destination",
          sourceProfile: "login-source",
          accountNumber: login.awsAccount.accountId,
          principalArn: login.principalArn,
        }),
      ]);
    } finally {
      table.mockRestore();
    }
  });

  test("Ctrl-C waits for Stop cleanup before exiting", async () => {
    let interrupt: () => void;
    let rejectStart: (error: Error) => void;
    let finishStop: () => void;
    const service = {
      start: jest.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectStart = reject;
          })
      ),
      stop: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            finishStop = resolve;
          })
      ),
    };
    const command = new StartSession([], {} as any);
    (command as any).cliProviderService = {
      sessionFactory: { getSessionService: () => service },
      remoteProceduresClient: { refreshSessions: jest.fn(async () => {}) },
    };
    command.log = jest.fn();
    const once = jest.spyOn(process, "once").mockImplementation((_event, listener) => {
      interrupt = listener;
      return process;
    });
    const exit = jest.spyOn(process, "exit").mockImplementation(() => undefined as never);
    try {
      const started = command.startSession(login);
      interrupt();
      rejectStart(new Error("cancelled"));
      await Promise.resolve();
      expect(service.stop).toHaveBeenCalledWith("login-id");
      expect(exit).not.toHaveBeenCalled();
      finishStop();
      await expect(started).rejects.toThrow("cancelled");
      expect(exit).toHaveBeenCalledWith(130);
      expect(command.log).not.toHaveBeenCalled();
    } finally {
      once.mockRestore();
      exit.mockRestore();
    }
  });

  test("Stop allows retry after partial cleanup left a login session inactive", async () => {
    const command = new StopSession([], {} as any);
    const stop = jest.fn(async () => {});
    (command as any).cliProviderService = {
      sessionFactory: { getSessionService: () => ({ stop }) },
      remoteProceduresClient: { refreshSessions: jest.fn(async () => {}) },
    };
    command.warn = jest.fn();
    command.log = jest.fn();
    await command.stopSession({ ...login, status: SessionStatus.inactive });
    expect(stop).toHaveBeenCalledWith("login-id");
  });

  test("current uses persisted identity without triggering AWS credential acquisition", async () => {
    const command = new CurrentSession([], {} as any);
    const service = { getAccountNumberFromCallerIdentity: jest.fn() };
    (command as any).cliProviderService = { sessionFactory: { getSessionService: () => service } };
    expect(command.getProviderAssociatedSessionTypes("aws")).toContain(SessionType.awsCliLogin);
    await expect(command.getSessionData(login)).resolves.toEqual({
      id: "login-id",
      alias: "CLI login",
      accountNumber: login.awsAccount.accountId,
      sourceProfile: "login-source",
      principalArn: login.principalArn,
    });
    expect(service.getAccountNumberFromCallerIdentity).not.toHaveBeenCalled();
  });

  test("start and stop selectors display source, account and principal", () => {
    for (const sessionCommand of [StartSession, StopSession]) {
      const command = new sessionCommand([], {} as any);
      expect(command.secondarySessionInfo(login)).toBe(`login-source - ${login.awsAccount.accountId} - ${login.principalArn}`);
    }
  });

  test("credential-process generation emits one JSON result and no success text", async () => {
    const credentials = {
      ["Version"]: 1,
      ["AccessKeyId"]: "mock-key",
      ["SecretAccessKey"]: "mock-secret",
      ["SessionToken"]: "mock-token",
      ["Expiration"]: "2030-01-01T00:00:00.000Z",
    };
    const service = Object.create(AwsSessionService.prototype);
    service.generateProcessCredentials = jest.fn(async () => credentials);
    const command = new GenerateSession([], {} as any);
    (command as any).cliProviderService = { sessionFactory: { getSessionService: () => service } };
    command.log = jest.fn();
    await command.generateSession(login);
    expect(service.generateProcessCredentials).toHaveBeenCalledWith("login-id");
    expect(command.log).toHaveBeenCalledTimes(1);
    expect(command.log).toHaveBeenCalledWith(JSON.stringify(credentials));
  });

  test("SSM rejects direct login sessions before generating credentials", async () => {
    const command = new StartSsmSession([], {} as any);
    const getSessionService = jest.fn();
    (command as any).cliProviderService = { sessionFactory: { getSessionService } };
    await expect(command.generateCredentials(login)).rejects.toThrow("AWS CLI Login sessions do not support SSM");
    expect(getSessionService).not.toHaveBeenCalled();
  });

  test("SSM excludes AWS CLI Login sessions from the interactive picker", async () => {
    const command = new StartSsmSession([], {} as any);
    const getSessionService = jest.fn();
    (command as any).cliProviderService = {
      sessionManagementService: { getSessions: () => [login] },
      sessionFactory: { getSessionService },
    };
    await expect(command.selectSession()).rejects.toThrow("no sessions available");
    expect(getSessionService).not.toHaveBeenCalled();
  });

  test.each([false, true])("console surfaces core unavailable error (print=%p)", async (print) => {
    const command = new OpenWebConsole([], {} as any);
    const getSessionService = jest.fn();
    const assertConsoleSupported = jest.fn(() => {
      throw new Error("AWS CLI Login console access is unavailable for IAM-user identities");
    });
    (command as any).cliProviderService = {
      awsCliLoginService: { assertConsoleSupported },
      sessionFactory: { getSessionService },
    };
    await expect(command.openWebConsole(login, { print })).rejects.toThrow("console access is unavailable");
    expect(assertConsoleSupported).toHaveBeenCalledWith(login);
    expect(getSessionService).not.toHaveBeenCalled();
  });
});
