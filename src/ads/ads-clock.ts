/** The server's clock, as a provider so a spec can set the instant (ADS-04). */
export const ADS_CLOCK = Symbol('ADS_CLOCK');
export type AdsClock = () => Date;
export const systemClock: AdsClock = () => new Date();
