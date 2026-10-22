import { Session } from "../session";
import { SessionType } from "../session-type";

export class AwsCliLoginSession extends Session {
  awsAccount?: { accountName: string; accountId: string };
  principalArn?: string;

  constructor(sessionName: string, region: string, public profileId: string, public sourceProfile: string) {
    super(sessionName, region);
    this.type = SessionType.awsCliLogin;
  }
}
