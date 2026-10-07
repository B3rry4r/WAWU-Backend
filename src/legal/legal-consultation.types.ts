/**
 * What the app's consultation and delivery routes answer (LEGAL-03).
 *
 * Money is integer kobo in a field ending `Kobo`, as every route added after
 * the money contract (docs/contract/CONVENTIONS.md). The older `/legal/*`
 * routes keep their whole-naira fields; nothing here replaces them.
 *
 * Every shape is a named interface so the contract publishes one schema per
 * name (BACKEND_GAPS G-1). A field that can be absent is a nullable scalar,
 * never a nullable named object.
 */

/** The kinds of consultation the app can book. */
export type BookableMedium = 'zoom' | 'phone' | 'physical';

/** One kind of consultation WAWU has priced and switched on. */
export interface ConsultationOptionView {
  medium: BookableMedium;
  /** What the app calls it: "Video call", "Phone call", "In person". */
  label: string;
  /** How long it runs. Null for an in-person consultation WAWU gave no length. */
  minutes: number | null;
  /**
   * The price WAWU set in admin. Null only for an in-person consultation WAWU
   * left unpriced, which the app shows as "On request".
   */
  priceKobo: number | null;
  /**
   * True for an in-person consultation: it books no hour, and the team
   * arranges the time with the client directly.
   */
  onRequest: boolean;
}

export interface ConsultationOptionsView {
  timeZone: string;
  options: ConsultationOptionView[];
}

export interface ConsultationSlotView {
  /** ISO timestamp of the start. */
  startsAt: string;
  available: boolean;
}

export interface ConsultationDayView {
  /** YYYY-MM-DD in the consultation time zone. */
  date: string;
  slots: ConsultationSlotView[];
}

/** The calendar for one kind of consultation, at that kind's length. */
export interface ConsultationSlotsView {
  medium: BookableMedium;
  label: string;
  minutes: number;
  timeZone: string;
  /** How many days ahead the calendar runs, so the app never hard-codes it. */
  horizonDays: number;
  days: ConsultationDayView[];
}

/** A consultation booking on one legal request. */
export interface ConsultationBookingView {
  requestId: string;
  status: string;
  medium: 'chat' | 'zoom' | 'phone' | 'physical' | null;
  label: string | null;
  minutes: number | null;
  /** The price held when the booking was made. Null for an unpriced in-person one. */
  priceKobo: number | null;
  /** ISO start of the held hour. Null for an in-person consultation. */
  scheduledFor: string | null;
  /**
   * When an unpaid hold lets go of its hour. Null once the consultation is
   * paid (a paid hour is held until it is done) or when no hour is held.
   */
  holdExpiresAt: string | null;
  paid: boolean;
  paidAt: string | null;
}

/** One delivered file. */
export interface LegalDeliverableView {
  id: string;
  fileName: string;
  url: string;
  /** Page count, when the consultant gave one. */
  pages: number | null;
  /** The chat message this file arrived as. Null on a file with no message. */
  chatMessageId: string | null;
  postedAt: string;
}

export interface LegalDeliverablesView {
  requestId: string;
  status: string;
  items: LegalDeliverableView[];
}

/** What delivering files answers to the operator. */
export interface DeliverFilesResultView {
  requestId: string;
  status: string;
  deliveredAt: string | null;
  items: LegalDeliverableView[];
}

/** One consultation setting as an admin sees and edits it. */
export interface AdminConsultationPriceView {
  medium: 'chat' | 'zoom' | 'phone' | 'physical';
  label: string;
  priceKobo: number | null;
  minutes: number | null;
  enabled: boolean;
  /** Whether the app offers it now: switched on and, for a call, priced with a length. */
  offered: boolean;
  updatedAt: string | null;
}

/** One fixed-price service as an admin sees and edits it. */
export interface AdminServicePriceView {
  serviceCode: string;
  serviceName: string;
  category: string;
  priceKobo: number | null;
  updatedAt: string | null;
}

export interface AdminLegalPricesView {
  consultations: AdminConsultationPriceView[];
  services: AdminServicePriceView[];
}
