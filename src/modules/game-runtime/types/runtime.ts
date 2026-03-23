export interface AttributeChangeInput {
  entityType?: string | null;
  entityId?: string | null;
  field?: string | null;
  value?: unknown;
  source?: string | null;
}

export interface AppliedDelta {
  entityType: string;
  entityId: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
  source: string;
}

export interface TriggerHit {
  triggerId: number;
  name: string;
  eventType: string;
  actionCount: number;
}

export interface RuntimeActionExecutionResult {
  nextChapterId: number | null;
  sessionStatus: string;
}

export interface ApplyRuntimeActionInput {
  state: Record<string, any>;
  action: Record<string, any>;
  sourceTag: string;
  appliedDeltas: AppliedDelta[];
  nextChapterId: number | null;
  sessionStatus: string;
}

export interface TriggerExecutionInput {
  db: any;
  chapterId: number | null;
  state: Record<string, any>;
  messageContent: string;
  eventType: string;
  meta: Record<string, any>;
  initialStatus: string;
}

export interface TriggerExecutionResult {
  appliedDeltas: AppliedDelta[];
  triggerHits: TriggerHit[];
  nextChapterId: number | null;
  sessionStatus: string;
}

export interface TaskProgressInput {
  db: any;
  chapterId: number | null;
  state: Record<string, any>;
  messageContent: string;
  eventType: string;
  meta: Record<string, any>;
  now: number;
  nextChapterId: number | null;
  currentStatus: string;
}

export interface TaskProgressChange {
  taskId: number;
  title: string;
  previousStatus: string;
  nextStatus: string;
}

export interface TaskProgressResult {
  appliedDeltas: AppliedDelta[];
  taskProgressChanges: TaskProgressChange[];
  sessionStatus: string;
  nextChapterId: number | null;
  triggerHit: TriggerHit | null;
}

export interface SnapshotPolicyInput {
  saveSnapshot?: boolean | null;
  nextChapterId: number | null;
  prevChapterId: number | null;
  sessionStatus: string;
  prevStatus: string;
  round: number;
}

export interface SnapshotDecision {
  reason: string;
  shouldSave: boolean;
}

export interface PersistSnapshotInput {
  db: any;
  sessionId: string;
  stateJson: string;
  round: number;
  now: number;
  policy: SnapshotPolicyInput;
}

export interface PersistSnapshotResult {
  snapshotSaved: boolean;
  snapshotReason: string;
}
