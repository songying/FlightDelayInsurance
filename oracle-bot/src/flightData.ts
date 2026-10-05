/** What a flight-data source knows about one flight instance. Times are UTC unix seconds. */
export type FlightObservation =
  | { kind: "unknown"; detail?: string } // not departed yet, or no data
  | { kind: "departed"; actualDeparture: number }
  | { kind: "cancelled" }
  | { kind: "diverted"; actualDeparture?: number };

export interface FlightDataProvider {
  /** Look up the flight instance whose scheduled departure is `scheduledDeparture`. */
  lookup(flightNumber: string, scheduledDeparture: number): Promise<FlightObservation>;
}
