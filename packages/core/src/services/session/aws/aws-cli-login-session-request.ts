import { CreateAwsSessionRequest } from "../create-aws-session-request";

export interface AwsCliLoginSessionRequest extends CreateAwsSessionRequest {
  sourceProfile: string;
}
