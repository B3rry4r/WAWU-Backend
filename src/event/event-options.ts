import type {
  EventCategory,
  EventFormat,
  EventType,
} from '../../generated/prisma/enums';
import { commissionRate } from '../event-ticketing/event-ticketing.constants';
import {
  EVENT_ADDRESS_MAX,
  EVENT_DESCRIPTION_MAX,
  EVENT_HOST_ORG_MAX,
  EVENT_NAME_MAX,
  MAX_TICKET_TYPES_PER_EVENT,
  TICKET_NAME_MAX,
  TICKET_NAME_MIN,
  TICKET_PRICE_MAX_NAIRA,
  TICKET_PRICE_MIN_NAIRA,
  TICKET_QUANTITY_MAX,
  TICKET_QUANTITY_MIN,
} from './dto/create-event.dto';

/**
 * The words an app shows for each event value, and the value it sends back.
 *
 * WHY THE SERVER OWNS THEM (task EVENTS-02). The host wizard's category field
 * shows "Business & Finance" (E14) while the column holds `business`, and the
 * filter sheet's Kind chips show "Conference" and "Concert". If each client
 * kept its own table, the app, the web and the admin dashboard would drift
 * apart one label at a time. So GET /events/options hands every client the
 * same pairs, in the order a picker lists them.
 *
 * Every enum value appears exactly once: the `Record` types below fail the
 * build if a value is added to the schema without a label here.
 */
export interface EventOption<T extends string> {
  value: T;
  label: string;
}

/**
 * The rules POST /events holds a host's ticket types to, and the share of
 * each sale the host keeps (EVENTS-04). The app's wizard (E15) prints "You
 * keep 85% of every ticket. Set price to ₦0 for a free event." and checks a
 * price before sending it: both read these numbers, never a copy of them.
 */
export interface EventTicketRulesView {
  /** Whole percent of a paid ticket's price the host keeps (100 less WAWU's commission). */
  hostSharePercent: number;
  /** The lowest price; a ticket at this price is the free tier (R-8). */
  minPriceNaira: number;
  maxPriceNaira: number;
  minQuantity: number;
  maxQuantity: number;
  nameMinLength: number;
  nameMaxLength: number;
  /** How many ticket types one submit may carry. */
  maxTypes: number;
}

/** The longest text each field of POST /events takes (EVENTS-04). */
export interface EventFieldLimitsView {
  nameMax: number;
  descriptionMax: number;
  hostOrgMax: number;
  addressMax: number;
}

export interface EventOptionsView {
  categories: EventOption<EventCategory>[];
  formats: EventOption<EventFormat>[];
  types: EventOption<EventType>[];
  /** Added by EVENTS-04, additive: the ticket rules the host wizard shows and checks. */
  tickets: EventTicketRulesView;
  /** Added by EVENTS-04, additive: the wizard's field lengths. */
  fields: EventFieldLimitsView;
}

/**
 * "Business & Finance" is the canvas's (E14). The rest are not drawn; they
 * are written in the canvas's plain style and listed in the EVENTS-02 report
 * for the owner to read.
 */
const CATEGORY_LABELS: Record<EventCategory, string> = {
  business: 'Business & Finance',
  music: 'Music',
  entertainment: 'Entertainment',
  conference: 'Conference',
  training: 'Training',
  fashion: 'Fashion',
  lifestyle: 'Lifestyle',
  community: 'Community',
  church: 'Church',
  other: 'Other',
};

/** E13's three formats, as drawn. */
const FORMAT_LABELS: Record<EventFormat, string> = {
  in_person: 'In person',
  online: 'Online',
  hybrid: 'Hybrid',
};

/**
 * Conference, Workshop, Concert and Meetup are the filter sheet's Kind chips,
 * in its order; Summit, Webinar and Competition are the web's kinds after them.
 */
const TYPE_LABELS: Record<EventType, string> = {
  conference: 'Conference',
  workshop: 'Workshop',
  concert: 'Concert',
  meetup: 'Meetup',
  summit: 'Summit',
  webinar: 'Webinar',
  competition: 'Competition',
};

function toOptions<T extends string>(
  labels: Record<T, string>,
): EventOption<T>[] {
  return (Object.keys(labels) as T[]).map((value) => ({
    value,
    label: labels[value],
  }));
}

export function eventOptions(): EventOptionsView {
  return {
    categories: toOptions(CATEGORY_LABELS),
    formats: toOptions(FORMAT_LABELS),
    types: toOptions(TYPE_LABELS),
    tickets: {
      hostSharePercent: Math.round((1 - commissionRate()) * 100),
      minPriceNaira: TICKET_PRICE_MIN_NAIRA,
      maxPriceNaira: TICKET_PRICE_MAX_NAIRA,
      minQuantity: TICKET_QUANTITY_MIN,
      maxQuantity: TICKET_QUANTITY_MAX,
      nameMinLength: TICKET_NAME_MIN,
      nameMaxLength: TICKET_NAME_MAX,
      maxTypes: MAX_TICKET_TYPES_PER_EVENT,
    },
    fields: {
      nameMax: EVENT_NAME_MAX,
      descriptionMax: EVENT_DESCRIPTION_MAX,
      hostOrgMax: EVENT_HOST_ORG_MAX,
      addressMax: EVENT_ADDRESS_MAX,
    },
  };
}
