import { describe, expect, jest, test } from "@jest/globals";
import { AwsCliLoginService } from "@noovolari/leapp-core/services/session/aws/aws-cli-login-service";
import { SessionFactory } from "@noovolari/leapp-core/services/session-factory";
import { CliProviderService } from "./cli-provider-service";

jest.mock("@noovolari/leapp-core/services/session/aws/aws-cli-login-service");
jest.mock("@noovolari/leapp-core/services/session-factory");

describe("AWS CLI Login provider integration", () => {
  test("constructs a singleton with native Terminal support and appends it last to the session factory", () => {
    const provider = new CliProviderService();
    const dependencies = [
      "behaviouralSubjectService",
      "repository",
      "cliNativeService",
      "fileService",
      "awsCoreService",
      "logService",
      "awsIamUserService",
      "awsIamRoleFederatedService",
      "awsIamRoleChainedService",
      "awsSsoRoleService",
      "azureSessionService",
      "localstackSessionService",
    ];
    const mocks: Record<string, any> = {};
    for (const dependency of dependencies) {
      mocks[dependency] = { dependency };
      Object.defineProperty(provider, dependency, { value: mocks[dependency] });
    }

    const loginService = provider.awsCliLoginService;
    expect(provider.awsCliLoginService).toBe(loginService);
    expect(AwsCliLoginService).toHaveBeenCalledTimes(1);
    expect(AwsCliLoginService).toHaveBeenCalledWith(
      mocks.behaviouralSubjectService,
      mocks.repository,
      mocks.cliNativeService,
      mocks.fileService,
      mocks.awsCoreService,
      mocks.logService
    );
    const factory = provider.sessionFactory;
    expect(provider.sessionFactory).toBe(factory);
    expect(SessionFactory).toHaveBeenCalledWith(
      mocks.awsIamUserService,
      mocks.awsIamRoleFederatedService,
      mocks.awsIamRoleChainedService,
      mocks.awsSsoRoleService,
      mocks.azureSessionService,
      mocks.localstackSessionService,
      loginService
    );
  });
});
