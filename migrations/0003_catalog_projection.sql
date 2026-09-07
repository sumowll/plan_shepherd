-- Public geography provenance is stored once in catalog_sources and referenced per county.
-- Existing published summaries retain their inline provenance and remain readable.
ALTER TABLE catalog_plan_counties ADD COLUMN source_id TEXT;
ALTER TABLE catalog_plan_counties ADD COLUMN source_location TEXT;

-- New imports persist the same normalized location used by the deterministic matcher.
-- NULL on historical rows deliberately retains conservative compatibility at read time.
ALTER TABLE catalog_components ADD COLUMN location_key TEXT;
CREATE INDEX catalog_component_location ON catalog_components(release_id,plan_id,kind,location_key,lookup_key);

CREATE TRIGGER catalog_verify_geography_sources BEFORE UPDATE OF status ON catalog_releases
WHEN NEW.status='published' AND OLD.status='staging'
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM catalog_plan_counties c
    LEFT JOIN catalog_sources s ON s.release_id=c.release_id AND s.id=c.source_id
    WHERE c.release_id=NEW.id AND c.source_id IS NOT NULL AND s.id IS NULL
  ) THEN RAISE(ABORT,'Catalog geography has an unregistered source') END;
END;
