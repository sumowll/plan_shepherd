import { z } from 'zod';

// IDs are stable registration identifiers and safe URL path segments. They must
// never be reassigned to a different authorization server or environment.
export const connectorIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
export type ConnectorId = string;
export type ConnectorKind = 'provider' | 'payer';
export const importResourceSchema = z.enum(['Patient', 'Encounter', 'ExplanationOfBenefit', 'MedicationRequest', 'MedicationDispense', 'Condition']);
export type ImportResource = z.infer<typeof importResourceSchema>;
export type ScopeProfile = 'smart' | 'epic' | 'cigna';
