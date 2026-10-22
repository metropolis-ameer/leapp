import { Session } from "@noovolari/leapp-core/models/session";
import { SessionType } from "@noovolari/leapp-core/models/session-type";
import { AwsCliLoginSession } from "@noovolari/leapp-core/models/aws/aws-cli-login-session";

export const awsCliLoginValidationError = (
  sessionName: string,
  sourceProfile: string,
  region: string,
  destinationProfile: { value?: string; label: string },
  sessions: Session[],
  sessionId?: string
): string => {
  const source = sourceProfile?.trim();
  if (!sessionName?.trim()) {
    return "Enter a session alias.";
  }
  if (!source) {
    return "Enter a source AWS login profile.";
  }
  if (!region?.trim()) {
    return "Select a region.";
  }
  if (!destinationProfile?.label?.trim()) {
    return "Select or add a destination named profile.";
  }
  if (source === destinationProfile.label.trim()) {
    return "Source and destination profiles must be different.";
  }
  if (
    sessions.some(
      (session) =>
        session.type === SessionType.awsCliLogin && session.sessionId !== sessionId && (session as AwsCliLoginSession).sourceProfile === source
    )
  ) {
    return "This source profile is already assigned to another AWS CLI Login session.";
  }
  return "";
};
