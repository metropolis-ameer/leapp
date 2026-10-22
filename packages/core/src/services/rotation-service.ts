import { SessionFactory } from "./session-factory";
import { Repository } from "./repository";
import { SessionType } from "../models/session-type";

export class RotationService {
  constructor(private sessionServiceFactory: SessionFactory, private repository: Repository) {}

  rotate(): void {
    const activeSessions = this.repository.listActive();
    activeSessions.forEach((session) => {
      const expiration = Date.parse(session.sessionTokenExpiration);
      const needsRotation =
        session.type === SessionType.awsCliLogin ? !Number.isFinite(expiration) || expiration <= Date.now() + 5 * 60 * 1000 : session.expired();
      if (needsRotation) {
        const concreteSessionService = this.sessionServiceFactory.getSessionService(session.type);
        concreteSessionService.rotate(session.sessionId).then((_) => {});
      }
    });
  }
}
