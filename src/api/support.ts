/** Support tickets (PROMPT 49): requester and staff API. Screenshots go up in the same request as the message. */
import { api, type Page } from './client';

export type TicketStatus = 'open' | 'in_progress' | 'waiting_user' | 'resolved' | 'closed';
export type TicketPerson = { id: number; name: string; role: string; email?: string } | null;
export type TicketMsg = { id: number; body: string; created_at: string; attachment: { id: string; content_type: string } | null;
  from_staff: boolean; author: TicketPerson; internal?: boolean };
export type Ticket = { id: number; category: string; category_label: string; subject: string; status: TicketStatus; status_label: string;
  created_at: string; last_activity_at: string; resolved_at: string | null; messages?: TicketMsg[];
  requester?: TicketPerson; assignee?: TicketPerson };

const form = (fields: Record<string, string | boolean | undefined>, image?: File | null) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) f.append(k, String(v));
  if (image) f.append('image', image, image.name || 'screenshot');
  return f;
};

export const myTickets = () => api<{ results: Ticket[]; categories: { value: string; label: string }[] }>('GET', 'support/tickets');
export const myTicket = (id: number) => api<Ticket>('GET', `support/tickets/${id}`);
export const openTicket = (d: { category: string; subject: string; message: string }, image?: File | null) =>
  api<Ticket>('POST', 'support/tickets', form(d, image));
export const replyTicket = (id: number, message: string, image?: File | null) => api<Ticket>('POST', `support/tickets/${id}/messages`, form({ message }, image));
export const closeTicket = (id: number) => api<Ticket>('POST', `support/tickets/${id}/close`);

export const adminTickets = (p: Record<string, string>) => api<Page<Ticket>>('GET', `admin/support/tickets?${new URLSearchParams(p)}`);
export const adminTicket = (id: number) => api<Ticket>('GET', `admin/support/tickets/${id}`);
export const adminUpdateTicket = (id: number, d: { status?: TicketStatus; assignee?: number | null }) => api<Ticket>('PATCH', `admin/support/tickets/${id}`, d);
export const adminReply = (id: number, d: { message: string; internal: boolean; status?: TicketStatus }, image?: File | null) =>
  api<Ticket>('POST', `admin/support/tickets/${id}/messages`, form({ message: d.message, internal: d.internal, status: d.status }, image));
export const supportCounts = () => api<Record<TicketStatus | 'unassigned_open', number>>('GET', 'admin/support/counts');
export const supportStaff = () => api<{ results: { id: number; name: string }[] }>('GET', 'admin/support/staff');
export const mediaUrl = (id: string) => api<{ url: string }>('GET', `media/${id}`);

export const STATUS_LABEL: Record<TicketStatus, string> = { open: 'مفتوح', in_progress: 'قيد المعالجة', waiting_user: 'بانتظار ردّك', resolved: 'تم الحل', closed: 'مغلق' };
export const IMAGE_TYPES = 'image/png,image/jpeg,image/webp';
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
