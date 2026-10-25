/**
 * Domain models. These mirror the suggested backend entities in project/HANDOFF.md
 * (Assignment, Submission, Review, AvailabilitySlot, Booking/Session…), so the demo
 * layer in ./demo.ts can be swapped for API calls without touching the screens.
 */
export type Role = 'student' | 'teacher' | 'parent' | 'admin';
export type TaskType = 'hifz' | 'review' | 'tajweed';
export type TaskStatus = 'not_started' | 'in_progress' | 'submitted' | 'reviewed' | 'needs_repeat';
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
  id: string; name: string; ini: string; /** 0 = unknown */ age: number; level: string; plan: string; att: string; late?: boolean;
  /** Live mode: has an active guardian link. */ guardian?: boolean;
}

export interface Task {
  id: string; type: TaskType; title: string;
  /** Surah number */ s: number; from: number; to: number;
  due: string; status: TaskStatus; today?: boolean; instr: string; at?: string; isNew?: boolean;
  /** Live mode: real instant, assigning teacher, and (teacher app) the student. */ dueAt?: string; teacherName?: string; sid?: string;
}

export interface TimedNote { t: number; text: string }
export interface Scores { hifz: number; tajweed: number; fluency: number }
export type Decision = 'approve' | 'redo';

export interface Feedback {
  teacher: string; date: string; dur: number; scores: Scores; decision: Decision;
  notes: TimedNote[]; voice: number | null; general: string; needs: string; next: string;
  /** Live mode: signed, short-lived URL of the teacher's voice note. */ voiceUrl?: string | null;
}

export interface Recording { dur: number; url?: string | null; gone?: boolean }

export interface Session {
  id: string; t: string; day?: number; past?: string; h: number; type: string; dur: number;
  status: SessionStatus; task: string | null; note?: string; summary?: string;
  /** Live mode: real instants from the server (demo sessions use day/h). */
  teacherName?: string; startsAt?: string; endsAt?: string; canJoin?: boolean; hasLink?: boolean; attendance?: string;
  /** The student's excuse for this session (students never cancel; they ask to be excused). */
  excuse?: { status: 'pending' | 'approved' | 'rejected'; reason?: string; teacher_response?: string } | null;
  canExcuse?: boolean; excuseDeadline?: string;
  /** Teacher-created session: «حفظ» / «مراجعة» … and an optional title and preparation note. */
  topic?: string; title?: string; prepNote?: string;
}

/** Live mode adds the occurrence id, its instant and kind; `h` is then local hour + minutes/60. */
/** `occ`: a session id, or the token of a time computed from the teacher's availability («s:…»). */
export interface Slot { h: number; taken: boolean; occ?: number | string; iso?: string; kind?: string }
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
