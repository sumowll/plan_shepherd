import { z } from 'zod';

// Generate once per connection registration, persist, and never reassign.
// Canonical casing keeps lookup, signatures and imported source IDs consistent.
export const connectorIdSchema = z.uuid().toLowerCase().refine(value =>
  value !== '00000000-0000-0000-0000-000000000000' && value !== 'ffffffff-ffff-ffff-ffff-ffffffffffff');
// Readable routing keys and organization identifiers occupy a separate namespace.
export const connectorKeySchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/).refine(value => !z.uuid().safeParse(value).success);
export type ConnectorId = string;
export type ConnectorKind = 'provider' | 'payer';
// Connection role and API purpose are independent. Only patient_access
// currently has an implementation in the patient sign-in/import flow.
export const connectorApiTypeSchema = z.enum(['patient_access', 'payer_to_payer', 'provider_directory']);
export type ConnectorApiType = z.infer<typeof connectorApiTypeSchema>;
export const importResourceSchema = z.enum(['Patient', 'Encounter', 'ExplanationOfBenefit', 'MedicationRequest', 'MedicationDispense', 'Condition']);
export type ImportResource = z.infer<typeof importResourceSchema>;
// Native returned-grant formats may accompany standard SMART patient scopes.
export const grantedScopeFormatSchema = z.enum(['smart', 'resource_operations', 'read_search']);
export type GrantedScopeFormat = z.infer<typeof grantedScopeFormatSchema>;
