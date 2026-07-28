// Workboard type declarations define plugin contracts.
export const WORKBOARD_STATUSES = [
  "triage",
  "backlog",
  "todo",
  "scheduled",
  "ready",
  "running",
  "review",
  "blocked",
  "done",
] as const;

export const WORKBOARD_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const WORKBOARD_EXECUTION_ENGINES = ["codex", "claude"] as const;
export const WORKBOARD_EXECUTION_MODES = ["autonomous", "manual"] as const;
export const WORKBOARD_EXECUTION_STATUSES = [
  "idle",
  "running",
  "review",
  "blocked",
  "done",
] as const;
export const WORKBOARD_EVENT_KINDS = [
  "created",
  "edited",
  "moved",
  "linked",
  "specified",
  "decomposed",
  "claimed",
  "heartbeat",
  "execution_updated",
  "attempt_started",
  "attempt_updated",
  "comment_added",
  "link_added",
  "proof_added",
  "artifact_added",
  "attachment_added",
  "diagnostic",
  "notification",
  "dispatch",
  "orchestration",
  "protocol_violation",
  "archived",
  "unarchived",
  "stale",
] as const;
export const WORKBOARD_ATTEMPT_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "blocked",
  "stopped",
] as const;
export const WORKBOARD_LINK_TYPES = [
  "parent",
  "child",
  "blocks",
  "blocked_by",
  "relates_to",
] as const;
export const WORKBOARD_PROOF_STATUSES = ["passed", "failed", "skipped", "unknown"] as const;
export const WORKBOARD_TEMPLATE_IDS = ["bugfix", "docs", "release", "pr_review", "plugin"] as const;
export const WORKBOARD_DIAGNOSTIC_KINDS = [
  "stranded_ready",
  "running_without_heartbeat",
  "blocked_too_long",
  "repeated_failures",
  "missing_proof",
  "orphaned_session",
] as const;
export const WORKBOARD_DIAGNOSTIC_SEVERITIES = ["warning", "error", "critical"] as const;
export const WORKBOARD_NOTIFICATION_KINDS = ["completed", "failed", "stale"] as const;

export type WorkboardStatus = (typeof WORKBOARD_STATUSES)[number];
export type WorkboardPriority = (typeof WORKBOARD_PRIORITIES)[number];
export type WorkboardExecutionEngine = (typeof WORKBOARD_EXECUTION_ENGINES)[number];
export type WorkboardExecutionMode = (typeof WORKBOARD_EXECUTION_MODES)[number];
export type WorkboardExecutionStatus = (typeof WORKBOARD_EXECUTION_STATUSES)[number];
export type WorkboardEventKind = (typeof WORKBOARD_EVENT_KINDS)[number];
export type WorkboardAttemptStatus = (typeof WORKBOARD_ATTEMPT_STATUSES)[number];
export type WorkboardLinkType = (typeof WORKBOARD_LINK_TYPES)[number];
export type WorkboardProofStatus = (typeof WORKBOARD_PROOF_STATUSES)[number];
export type WorkboardTemplateId = (typeof WORKBOARD_TEMPLATE_IDS)[number];
export type WorkboardDiagnosticKind = (typeof WORKBOARD_DIAGNOSTIC_KINDS)[number];
export type WorkboardDiagnosticSeverity = (typeof WORKBOARD_DIAGNOSTIC_SEVERITIES)[number];
export type WorkboardNotificationKind = (typeof WORKBOARD_NOTIFICATION_KINDS)[number];

export type WorkboardExecution = {
  id: string;
  kind: "agent-session";
  engine: WorkboardExecutionEngine;
  mode: WorkboardExecutionMode;
  status: WorkboardExecutionStatus;
  model: string;
  sessionKey?: string;
  runId?: string;
  startedAt: number;
  updatedAt: number;
};

export type WorkboardEvent = {
  id: string;
  kind: WorkboardEventKind;
  at: number;
  fromStatus?: WorkboardStatus;
  toStatus?: WorkboardStatus;
  sessionKey?: string;
  runId?: string;
};

export type WorkboardRunAttempt = {
  id: string;
  status: WorkboardAttemptStatus;
  startedAt: number;
  endedAt?: number;
  engine?: WorkboardExecutionEngine;
  mode?: WorkboardExecutionMode;
  model?: string;
  sessionKey?: string;
  runId?: string;
  error?: string;
};

export type WorkboardComment = {
  id: string;
  body: string;
  createdAt: number;
  updatedAt?: number;
};

export type WorkboardLink = {
  id: string;
  type: WorkboardLinkType;
  createdAt: number;
  targetCardId?: string;
  title?: string;
  url?: string;
};

export type WorkboardProof = {
  id: string;
  status: WorkboardProofStatus;
  createdAt: number;
  label?: string;
  command?: string;
  url?: string;
  note?: string;
};

export type WorkboardArtifact = {
  id: string;
  createdAt: number;
  label?: string;
  url?: string;
  path?: string;
  mimeType?: string;
};

export type WorkboardAttachment = {
  id: string;
  cardId: string;
  createdAt: number;
  fileName: string;
  byteSize: number;
  mimeType?: string;
  note?: string;
};

export type WorkboardWorkerLog = {
  id: string;
  createdAt: number;
  level: "info" | "warning" | "error";
  message: string;
  sessionKey?: string;
  runId?: string;
};

export type WorkboardWorkerProtocol = {
  state: "idle" | "running" | "completed" | "blocked" | "violated";
  updatedAt: number;
  detail?: string;
};

export type WorkboardStaleState = {
  detectedAt: number;
  lastSessionUpdatedAt?: number;
  reason: string;
};

export type WorkboardClaim = {
  ownerId: string;
  token: string;
  claimedAt: number;
  lastHeartbeatAt: number;
  expiresAt?: number;
};

export type WorkboardDiagnosticAction = {
  kind: "claim" | "unblock" | "promote" | "reclaim" | "reassign" | "add_proof" | "open_session";
  label: string;
};

export type WorkboardDiagnostic = {
  kind: WorkboardDiagnosticKind;
  severity: WorkboardDiagnosticSeverity;
  title: string;
  detail: string;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
  actions: WorkboardDiagnosticAction[];
};

export type WorkboardNotification = {
  id: string;
  kind: WorkboardNotificationKind;
  createdAt: number;
  sequence?: number;
  message: string;
  sessionKey?: string;
  runId?: string;
};

export type WorkboardWorkspace = {
  kind: "scratch" | "dir" | "worktree";
  path?: string;
  branch?: string;
  sourcePath?: string;
  sourceBranch?: string;
};

export type WorkboardAutomation = {
  tenant?: string;
  boardId?: string;
  createdByCardId?: string;
  idempotencyKey?: string;
  skills?: string[];
  workspace?: WorkboardWorkspace;
  maxRuntimeSeconds?: number;
  maxRetries?: number;
  scheduledAt?: number;
  summary?: string;
  createdCardIds?: string[];
  dispatchCount?: number;
  lastDispatchAt?: number;
};

export type WorkboardBoardMetadata = {
  id: string;
  name?: string;
  description?: string;
  icon?: string;
  color?: string;
  defaultWorkspace?: WorkboardWorkspace;
  orchestration?: WorkboardOrchestrationSettings;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
};

export type WorkboardOrchestrationSettings = {
  autoDecompose?: boolean;
  autoDecomposePerDispatch?: number;
  defaultAssignee?: string;
  orchestratorProfile?: string;
};

export type WorkboardNotificationSubscription = {
  id: string;
  boardId: string;
  cardId?: string;
  sessionKey?: string;
  runId?: string;
  target?: string;
  eventKinds?: WorkboardNotificationKind[];
  lastEventAt?: number;
  lastEventId?: string;
  lastEventSequence?: number;
  deliveredEventIds?: string[];
  createdAt: number;
  updatedAt: number;
};

export type WorkboardMetadata = {
  attempts?: WorkboardRunAttempt[];
  comments?: WorkboardComment[];
  links?: WorkboardLink[];
  proof?: WorkboardProof[];
  artifacts?: WorkboardArtifact[];
  attachments?: WorkboardAttachment[];
  workerLogs?: WorkboardWorkerLog[];
  workerProtocol?: WorkboardWorkerProtocol;
  automation?: WorkboardAutomation;
  claim?: WorkboardClaim;
  diagnostics?: WorkboardDiagnostic[];
  notifications?: WorkboardNotification[];
  templateId?: WorkboardTemplateId;
  archivedAt?: number;
  stale?: WorkboardStaleState;
  lifecycleStatusSourceUpdatedAt?: number;
  failureCount?: number;
};

export type WorkboardCard = {
  id: string;
  title: string;
  notes?: string;
  status: WorkboardStatus;
  priority: WorkboardPriority;
  labels: string[];
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  taskId?: string;
  sourceUrl?: string;
  execution?: WorkboardExecution;
  position: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  events?: WorkboardEvent[];
  metadata?: WorkboardMetadata;
};

export type WorkboardListResult = {
  cards: WorkboardCard[];
  statuses: readonly WorkboardStatus[];
};

// AUT-WB-ATOMIC server boundary (contract aut-wb-atomic/1, child aut-wb-atomic-server/1).
// The reason-code set, envelope field set, and ok/outcome/retryable combinations are
// frozen by that contract; changing any of them requires a contract-version reset.
export const WORKBOARD_ATOMIC_REASON_CODES = [
  "workboard_card_created",
  "workboard_card_recovered",
  "workboard_card_conflict",
  "workboard_create_request_invalid",
  "workboard_stored_record_invalid",
  "workboard_card_state_incompatible",
  "workboard_unavailable",
  "workboard_storage_failure",
  "workboard_result_uncertain",
  "workboard_atomic_migration_required",
  "workboard_incompatible_legacy_card",
  "workboard_result_invalid",
] as const;

export const WORKBOARD_ATOMIC_OUTCOMES = [
  "created",
  "recovered",
  "refused",
  "failed",
  "uncertain",
] as const;

export type WorkboardAtomicReasonCode = (typeof WORKBOARD_ATOMIC_REASON_CODES)[number];
export type WorkboardAtomicOutcome = (typeof WORKBOARD_ATOMIC_OUTCOMES)[number];

export const WORKBOARD_ATOMIC_REASON_TABLE = {
  workboard_card_created: { ok: true, outcome: "created", retryable: false },
  workboard_card_recovered: { ok: true, outcome: "recovered", retryable: false },
  workboard_card_conflict: { ok: false, outcome: "refused", retryable: false },
  workboard_create_request_invalid: { ok: false, outcome: "refused", retryable: false },
  workboard_stored_record_invalid: { ok: false, outcome: "refused", retryable: false },
  workboard_card_state_incompatible: { ok: false, outcome: "refused", retryable: false },
  workboard_unavailable: { ok: false, outcome: "failed", retryable: true },
  workboard_storage_failure: { ok: false, outcome: "failed", retryable: true },
  workboard_result_uncertain: { ok: false, outcome: "uncertain", retryable: true },
  workboard_atomic_migration_required: { ok: false, outcome: "refused", retryable: false },
  workboard_incompatible_legacy_card: { ok: false, outcome: "refused", retryable: false },
  workboard_result_invalid: { ok: false, outcome: "failed", retryable: true },
} as const satisfies Record<
  WorkboardAtomicReasonCode,
  { ok: boolean; outcome: WorkboardAtomicOutcome; retryable: boolean }
>;

export const WORKBOARD_ATOMIC_LABELS = ["automation", "hold", "operator-merge-only"] as const;
export const WORKBOARD_ATOMIC_RISK_CLASSES = [
  "read-only",
  "draft-only",
  "internal-effect",
  "external-effect",
] as const;
export const WORKBOARD_ATOMIC_APPROVAL_POLICIES = [
  "operator-required",
  "auto-within-risk-class",
] as const;

export type WorkboardAtomicRiskClass = (typeof WORKBOARD_ATOMIC_RISK_CLASSES)[number];
export type WorkboardAtomicApprovalPolicy = (typeof WORKBOARD_ATOMIC_APPROVAL_POLICIES)[number];

export type CanonicalAutomationCardSpecV1 = {
  schema_version: 1;
  board: {
    id: string;
    ref: string;
    lane: string | null;
    template_ref: string | null;
  };
  title: string;
  initial_status: "backlog";
  priority: "normal";
  labels: [
    (typeof WORKBOARD_ATOMIC_LABELS)[0],
    (typeof WORKBOARD_ATOMIC_LABELS)[1],
    (typeof WORKBOARD_ATOMIC_LABELS)[2],
  ];
  notes: string;
  automation: {
    occurrence_key: string;
    automation_id: string;
    schedule_revision: number;
    scheduled_at: string;
    skill_name: string;
    skill_version: string;
    risk_class: WorkboardAtomicRiskClass;
    approval_policy: WorkboardAtomicApprovalPolicy;
    output_contract_ref: string;
    verification_contract_ref: string;
  };
  execution_control: {
    assignee_id: null;
    claim_owner_id: null;
    execution_id: null;
    execution_authorized: false;
  };
};

export type WorkboardAtomicCardProjectionV1 = {
  id: string;
  board_id: string;
  title: string;
  status: "backlog";
  priority: "normal";
  labels: CanonicalAutomationCardSpecV1["labels"];
  notes: string;
  agent_id: null;
  claim: null;
  execution: null;
  started_at: null;
  completed_at: null;
  archived_at: null;
};

export type WorkboardAtomicEvidenceV1 = {
  kind: "workboard_atomic_receipt";
  ref: string;
};

export type AtomicCreateResponseV1 = {
  schema_version: 1;
  ok: boolean;
  outcome: WorkboardAtomicOutcome;
  reason_code: WorkboardAtomicReasonCode;
  retryable: boolean;
  correlation_key: string | null;
  card: WorkboardAtomicCardProjectionV1 | null;
  stored_spec: CanonicalAutomationCardSpecV1 | null;
  stored_fingerprint: string | null;
  evidence: WorkboardAtomicEvidenceV1 | null;
};

export type AtomicCreateReceiptV1 = {
  schema_version: 1;
  id: string;
  correlation_key: string;
  card_id: string | null;
  request_fingerprint: string;
  stored_fingerprint: string | null;
  outcome: WorkboardAtomicOutcome;
  reason_code: WorkboardAtomicReasonCode;
  detail_code: string | null;
  created_at: string;
};

export type AtomicCreateReceiptLookupResponseV1 = {
  schema_version: 1;
  receipt: AtomicCreateReceiptV1 | null;
};
