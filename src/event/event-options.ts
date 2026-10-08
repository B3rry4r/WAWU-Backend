import type {
  EventCategory,
  EventFormat,
  EventType,
} from '../../generated/prisma/enums';

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

export interface EventOptionsView {
  categories: EventOption<EventCategory>[];
  formats: EventOption<EventFormat>[];
  types: EventOption<EventType>[];
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
  };
}
