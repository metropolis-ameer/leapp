import { SelectedSessionActionsService } from "./selected-session-actions.service";
import { ExtensionWebsocketService, FetchingState } from "./extension-websocket.service";
import { SessionType } from "@noovolari/leapp-core/models/session-type";
import { Session } from "@noovolari/leapp-core/models/session";
import { AppProviderService } from "./app-provider.service";
import { AwsCliLoginService } from "@noovolari/leapp-core/services/session/aws/aws-cli-login-service";

describe("AWS CLI Login desktop actions", () => {
  const session = { type: SessionType.awsCliLogin, sessionId: "session-id" } as Session;
  let provider: any;
  let modal: any;
  let toaster: any;
  let actions: SelectedSessionActionsService;

  beforeEach(() => {
    provider = {
      sessionFactory: { getSessionService: jasmine.createSpy("getSessionService") },
      behaviouralSubjectService: { unselectSessions: jasmine.createSpy("unselectSessions") },
      awsCliLoginService: {
        assertConsoleSupported: jasmine.createSpy("assertConsoleSupported").and.throwError("AWS CLI Login web console is unavailable"),
      },
    };
    modal = { show: jasmine.createSpy("show") };
    toaster = { toast: jasmine.createSpy("toast") };
    actions = new SelectedSessionActionsService(provider, modal, {} as any, {} as any, {} as any, toaster, {} as any);
  });

  it("shows the core console-unavailable error before generating credentials", async () => {
    await actions.openAwsWebConsole(session);
    expect(provider.awsCliLoginService.assertConsoleSupported).toHaveBeenCalledWith(session);
    expect(provider.sessionFactory.getSessionService).not.toHaveBeenCalled();
    expect(toaster.toast.calls.mostRecent().args[0]).toBe("AWS CLI Login web console is unavailable");
  });

  it("does not open a generic URL through the extension or enter its fetching state", async () => {
    const extension = new ExtensionWebsocketService({} as any, provider, toaster, {} as any);
    await extension.openWebConsoleWithExtension(session);
    expect(provider.awsCliLoginService.assertConsoleSupported).toHaveBeenCalledWith(session);
    expect(provider.sessionFactory.getSessionService).not.toHaveBeenCalled();
    expect(extension.fetching$.getValue()).toBe(FetchingState.notFetching);
    expect(toaster.toast.calls.mostRecent().args[0]).toBe("AWS CLI Login web console is unavailable");
  });

  it("does not offer a chained-session dialog for CLI login", () => {
    actions.createAChainedSessionFromSelectedOne(session);
    expect(modal.show).not.toHaveBeenCalled();
  });

  it("does not offer an SSM dialog for CLI login", async () => {
    await actions.ssmModalOpen(session);
    expect(modal.show).not.toHaveBeenCalled();
  });

  it("registers a singleton CLI login service as the final desktop factory service", () => {
    const desktopProvider = new AppProviderService({} as any, toaster, {} as any, {} as any);
    Object.assign(desktopProvider, {
      behaviouralSubjectServiceInstance: {},
      repositoryInstance: {},
      fileServiceInstance: {},
      awsCoreServiceInstance: {},
      logServiceInstance: {},
      awsIamUserServiceInstance: {},
      awsIamRoleFederatedServiceInstance: {},
      awsIamRoleChainedServiceInstance: {},
      awsSsoRoleServiceInstance: {},
      azureServiceInstance: {},
      localstackServiceInstance: {},
    });
    const service = desktopProvider.awsCliLoginService;
    expect(service instanceof AwsCliLoginService).toBeTrue();
    expect(desktopProvider.awsCliLoginService).toBe(service);
    expect(desktopProvider.sessionFactory.getSessionService(SessionType.awsCliLogin)).toBe(service);
  });
});
