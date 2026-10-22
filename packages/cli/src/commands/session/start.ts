import { LeappCommand } from "../../leapp-command";
import { Config } from "@oclif/core/lib/config/config";
import { Session } from "@noovolari/leapp-core/models/session";
import { SessionStatus } from "@noovolari/leapp-core/models/session-status";
import { sessionRole, sessionId, noInteractive } from "../../flags";
import { SessionType } from "@noovolari/leapp-core/models/session-type";
import { AwsIamRoleFederatedSession } from "@noovolari/leapp-core/models/aws/aws-iam-role-federated-session";
import { AwsIamRoleChainedSession } from "@noovolari/leapp-core/models/aws/aws-iam-role-chained-session";
import { AwsSsoRoleSession } from "@noovolari/leapp-core/models/aws/aws-sso-role-session";
import { AzureSession } from "@noovolari/leapp-core/models/azure/azure-session";
import { AwsCliLoginSession } from "@noovolari/leapp-core/models/aws/aws-cli-login-session";
import { Args } from "@oclif/core";

export default class StartSession extends LeappCommand {
  static description = "Start a session";

  static examples = [
    `$leapp session start`,
    `$leapp session start SESSIONNAME`,
    `$leapp session start SESSIONNAME --sessionRole SESSIONROLE`,
    `$leapp session start SESSIONNAME --noInteractive`,
    `$leapp session start --sessionId SESSIONID`,
  ];

  static flags = {
    sessionId,
    sessionRole,
    noInteractive,
  };

  static args = {
    sessionName: Args.string({ required: false, description: "Name of the Leapp session" }),
  };

  constructor(argv: string[], config: Config) {
    super(argv, config);
  }

  async run(): Promise<void> {
    try {
      const { args, flags } = await this.parse(StartSession);
      let sessionNameFilter: string | undefined;
      let sessionRoleFilter: string | undefined;
      if (args.sessionName) {
        sessionNameFilter = args.sessionName;
      }
      if (flags.sessionRole && flags.sessionRole !== "") {
        sessionRoleFilter = flags.sessionRole;
      }
      const sessions = this.cliProviderService.sessionManagementService.getSessions();

      const selectedSessions = sessions
        .filter((s: Session) => (sessionNameFilter ? s.sessionName.includes(sessionNameFilter) : true))
        .filter((s: Session) => (sessionRoleFilter ? ((s as any).roleArn ? (s as any).roleArn.split("/")[1] === sessionRoleFilter : true) : true))
        .filter((s: Session) => (flags.sessionId && flags.sessionId !== "" ? s.sessionId === flags.sessionId : true));

      if (!selectedSessions || selectedSessions.length === 0 || (selectedSessions.length > 1 && flags.noInteractive)) {
        throw new Error("No sessions found");
      } else if (selectedSessions.length === 1) {
        await this.startSession(selectedSessions[0]);
      } else {
        const selectedSession = await this.selectSession(selectedSessions);
        await this.startSession(selectedSession);
      }
    } catch (error) {
      this.error(error instanceof Error ? error.message : `Unknown error: ${error}`);
    }
  }

  async startSession(session: Session): Promise<void> {
    if (session.status === SessionStatus.active) {
      throw new Error("session already started");
    }
    const sessionService = this.cliProviderService.sessionFactory.getSessionService(session.type);
    let cancellation: Promise<void> | undefined;
    const interrupt = () => {
      if (session.type === SessionType.awsCliLogin) {
        cancellation = (async () => {
          try {
            await sessionService.stop(session.sessionId);
            await this.cliProviderService.remoteProceduresClient.refreshSessions();
          } catch (error) {
            this.warn(error instanceof Error ? error.message : "AWS CLI Login cancellation failed");
          }
          process.exit(130);
        })();
      } else {
        sessionService.sessionDeactivated(session.sessionId);
        process.exit(0);
      }
    };
    process.once("SIGINT", interrupt);
    try {
      await sessionService.start(session.sessionId);
      if (!cancellation) {
        this.log(`session ${session.sessionName} started`);
      }
    } finally {
      await cancellation;
      process.removeListener("SIGINT", interrupt);
      await this.cliProviderService.remoteProceduresClient.refreshSessions();
    }
  }

  async selectSession(selectedSessions: Session[]): Promise<Session> {
    const availableSessions = selectedSessions.filter((session: Session) => session.status === SessionStatus.inactive);
    if (availableSessions.length === 0) {
      throw new Error("no sessions available");
    }
    if (availableSessions.length === 1) {
      return availableSessions[0];
    }
    const answer: any = await this.cliProviderService.inquirer.prompt([
      {
        name: "selectedSession",
        message: "select a session",
        type: "list",
        choices: availableSessions.map((session: Session) => ({
          name: `${session.sessionName}${this.secondarySessionInfo(session) ? " - " + this.secondarySessionInfo(session) : ""}`,
          value: session,
        })),
      },
    ]);
    return answer.selectedSession;
  }

  secondarySessionInfo(session: Session): string | undefined {
    switch (session.type) {
      case SessionType.awsIamRoleFederated:
        return (session as AwsIamRoleFederatedSession).roleArn.split("role/")[1] || "";
      case SessionType.awsIamRoleChained:
        return (session as AwsIamRoleChainedSession).roleArn.split("role/")[1] || "";
      case SessionType.awsIamUser:
        return "";
      case SessionType.awsCliLogin:
        const login = session as AwsCliLoginSession;
        return [login.sourceProfile, login.awsAccount?.accountId, login.principalArn].filter(Boolean).join(" - ");
      case SessionType.awsSsoRole:
        const splittedRoleArn = (session as AwsSsoRoleSession).roleArn.split("/");
        splittedRoleArn.splice(0, 1);
        return splittedRoleArn.join("/");
      case SessionType.azure:
        return (session as AzureSession).subscriptionId;
    }
    return undefined;
  }
}
