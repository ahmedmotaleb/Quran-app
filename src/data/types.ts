/**
 * Domain models. These mirror the suggested backend entities in project/HANDOFF.md
 * (Assignment, Submission, Review, AvailabilitySlot, Booking/Session…), so the demo
 * layer in ./demo.ts can be swapped for API calls without touching the screens.
 */
export type Role = 'student' | 'teacher' | 'parent' | 'admin';
export type TaskType = 'hifz' | 'review' | 'tajweed';
export type TaskStatus = 'not_started' | 'in_progress' | 'submitted' | 'reviewed';
export type SessionStatus = 'confirmed' | 'cancelled' | 'completed';
export type BadgeKind = TaskStatus | SessionStatus | 'late' | 'newsub';
export type TzId = 'cairo' | 'riyadh' | 'dubai' | 'kl' | 'london';

/** `iana` is the real timezone; offsets (incl. DST) are computed by Intl, never hardcoded. */
export interface TimeZone { id: TzId; label: string; iana: string }

export interface Teacher {
  id: string; name: string; ini: string; spec: string; tags: string[];
  types: string[]; levels: string; aud: string; bio: string;
}

export interface Student {
  id: string; name: string; ini: string; age: number; level: string; plan: string; att: string; late?: boolean;
}

export interface Task {
  id: string; type: TaskType; title: string;
  /** Surah number */ s: number; from: number; to: number;
  due: string; status: TaskStatus; today?: boolean; instr: string; at?: string; isNew?: boolean;
}

export interface TimedNote { t: number; text: string }
export interface Scores { hifz: number; tajweed: number; fluency: number }
export type Decision = 'approve' | 'redo';

export interface Feedback {
  teacher: string; date: string; dur: number; scores: Scores; decision: Decision;
  notes: TimedNote[]; voice: number | null; general: string; needs: string; next: string;
}

export interface Recording { dur: number; url?: string | null }

export interface Session {
  id: string; t: string; day?: number; past?: string; h: number; type: string; dur: number;
  status: SessionStatus; task: string | null; note?: string; summary?: string;
}

export interface Slot { h: number; taken: boolean }
/** teacherId → 7 days → slots (hours in Riyadh time, GMT+3). */
export type Availability = Record<string, Slot[][]>;

export interface OtherSubmission {
  id: string; student: string; sid: string; title: string; range: string; dur: number; at: string;
  status: 'submitted' | 'reviewed';
}

export interface Lesson {
  id: string; title: string; topic: string; topicL: string; level: string; media: 'video' | 'audio'; dur: string;
}

export interface QuizQuestion { q: string; o?: string[]; a?: number; rec?: boolean }

export interface SurahListItem { n: number; name: string; c: number }
export interface Ayah { numberInSurah: number; text: string; juz: number }
export interface SurahData { number: number; name: string; numberOfAyahs: number; ayahs: Ayah[] }
