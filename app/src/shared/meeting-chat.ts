import type { SummaryGeneration } from "../pipeline/evidence.js";

export type ChatStatus = "queued" | "retrieving" | "generating" | "completed" | "failed" | "cancelled" | "interrupted";

export interface ChatAnswer {
  text: string;
  refs: number[];
  sufficient: boolean;
}

export interface ChatGeneration extends SummaryGeneration {
  retrievalMode: "full" | "fts" | "scan";
  exhaustive: boolean;
  retrievalCalls: number;
}

export interface ChatRecord {
  id: string;
  meetingId: number;
  revision: string;
  question: string;
  status: ChatStatus;
  answer: ChatAnswer | null;
  error: string | null;
  generation: ChatGeneration | null;
  createdAt: string;
}
