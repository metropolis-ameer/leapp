import { SessionType } from "../models/session-type";
import { AwsIamRoleChainedService } from "./session/aws/aws-iam-role-chained-service";
import { AwsIamRoleFederatedService } from "./session/aws/aws-iam-role-federated-service";
import { AwsIamUserService } from "./session/aws/aws-iam-user-service";
import { AwsSsoRoleService } from "./session/aws/aws-sso-role-service";
import { AzureSessionService } from "./session/azure/azure-session-service";
import { CreateSessionRequest } from "./session/create-session-request";
import { SessionService } from "./session/session-service";
import { LocalstackSessionService } from "./session/localstack/localstack-session-service";
import { AwsCliLoginService } from "./session/aws/aws-cli-login-service";

export class SessionFactory {
  constructor(
    private readonly awsIamUserService: AwsIamUserService,
    private readonly awsIamRoleFederatedService: AwsIamRoleFederatedService,
    private readonly awsIamRoleChainedService: AwsIamRoleChainedService,
    private readonly awsSsoRoleService: AwsSsoRoleService,
    private readonly azureSessionService: AzureSessionService,
    private readonly localstackSessionService: LocalstackSessionService,
    private readonly awsCliLoginService?: AwsCliLoginService
  ) {
    [awsIamUserService, awsIamRoleFederatedService, awsIamRoleChainedService, awsSsoRoleService, awsCliLoginService].forEach((service) =>
      service?.setSessionServiceResolver?.((type) => this.getSessionService(type))
    );
  }

  getSessionService(sessionType: SessionType): SessionService {
    switch (sessionType) {
      case SessionType.awsCliLogin:
        if (!this.awsCliLoginService) {
          throw new Error("AWS CLI Login service is not configured");
        }
        return this.awsCliLoginService;
      case SessionType.awsIamUser:
        return this.awsIamUserService;
      case SessionType.awsIamRoleFederated:
        return this.awsIamRoleFederatedService;
      case SessionType.awsIamRoleChained:
        return this.awsIamRoleChainedService;
      case SessionType.awsSsoRole:
        return this.awsSsoRoleService;
      case SessionType.azure:
        return this.azureSessionService;
      case SessionType.localstack:
        return this.localstackSessionService;
      case SessionType.anytype:
        return this.azureSessionService as SessionService;
    }
  }

  async createSession(sessionType: SessionType, sessionRequest: CreateSessionRequest): Promise<void> {
    const sessionService = this.getSessionService(sessionType);
    await sessionService.create(sessionRequest);
  }

  getCompatibleTypes(sessionType: SessionType): SessionType[] {
    if (sessionType === SessionType.aws) {
      return [
        SessionType.awsIamUser,
        SessionType.awsIamRoleFederated,
        SessionType.awsIamRoleChained,
        SessionType.awsSsoRole,
        SessionType.awsCliLogin,
      ];
    } else if (sessionType === SessionType.anytype) {
      return [SessionType.azure, SessionType.alibaba, ...this.getCompatibleTypes(SessionType.aws)];
    } else if (this.getCompatibleTypes(SessionType.anytype).includes(sessionType)) {
      return [sessionType];
    }
    return [];
  }
}
