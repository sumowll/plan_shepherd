-- Public reference data only. Patient information, preferences, claims and tokens do not belong in this database.
PRAGMA foreign_keys = ON;
CREATE TABLE catalog_releases (
  id TEXT PRIMARY KEY,
  year INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  expected_plans INTEGER NOT NULL,
  expected_rates INTEGER NOT NULL,
  expected_sources INTEGER NOT NULL,
  expected_coverage INTEGER NOT NULL,
  expected_components INTEGER NOT NULL,
  expected_counties INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'staging' CHECK(status IN ('staging','published'))
);
CREATE TABLE catalog_sources (
  release_id TEXT NOT NULL REFERENCES catalog_releases(id), id TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)), PRIMARY KEY(release_id,id)
);
CREATE TABLE catalog_plans (
  release_id TEXT NOT NULL REFERENCES catalog_releases(id), id TEXT NOT NULL,
  state TEXT NOT NULL, family TEXT NOT NULL CHECK(family IN ('aca','short_term','medicare_advantage')),
  year INTEGER NOT NULL, status TEXT NOT NULL, name TEXT NOT NULL,
  effective_start TEXT NOT NULL, effective_end TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)), PRIMARY KEY(release_id,id)
);
CREATE INDEX catalog_search ON catalog_plans(release_id,state,year,family,name,id);
CREATE TABLE catalog_plan_counties (
  release_id TEXT NOT NULL, plan_id TEXT NOT NULL, county_fips TEXT NOT NULL,
  whole_county INTEGER NOT NULL CHECK(whole_county IN (0,1)), zip_codes TEXT NOT NULL CHECK(json_valid(zip_codes)),
  PRIMARY KEY(release_id,plan_id,county_fips), FOREIGN KEY(release_id,plan_id) REFERENCES catalog_plans(release_id,id)
);
CREATE INDEX catalog_county_search ON catalog_plan_counties(release_id,county_fips,plan_id);
CREATE TABLE catalog_premium_rates (
  release_id TEXT NOT NULL, id TEXT NOT NULL, plan_id TEXT NOT NULL, county_fips TEXT NOT NULL,
  min_age INTEGER NOT NULL, max_age INTEGER NOT NULL, tobacco TEXT NOT NULL,
  effective_start TEXT NOT NULL, effective_end TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)), PRIMARY KEY(release_id,id),
  FOREIGN KEY(release_id,plan_id) REFERENCES catalog_plans(release_id,id)
);
CREATE INDEX catalog_rate_lookup ON catalog_premium_rates(release_id,plan_id,county_fips,min_age,max_age);
CREATE TABLE catalog_components (
  release_id TEXT NOT NULL, plan_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('provider','drug','price')),
  ordinal INTEGER NOT NULL, lookup_key TEXT, lookup_key_2 TEXT,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)), PRIMARY KEY(release_id,plan_id,kind,ordinal),
  FOREIGN KEY(release_id,plan_id) REFERENCES catalog_plans(release_id,id)
);
CREATE INDEX catalog_component_lookup ON catalog_components(release_id,plan_id,kind,lookup_key);
CREATE INDEX catalog_component_lookup_2 ON catalog_components(release_id,plan_id,kind,lookup_key_2);
CREATE TABLE catalog_coverage (
  release_id TEXT NOT NULL REFERENCES catalog_releases(id), state TEXT NOT NULL, family TEXT NOT NULL, year INTEGER NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)), PRIMARY KEY(release_id,state,family,year)
);
CREATE TABLE catalog_active (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), release_id TEXT NOT NULL REFERENCES catalog_releases(id)
);
-- The single pointer change is atomic. The trigger prevents partially loaded releases from becoming visible.
CREATE TRIGGER catalog_verify_publication BEFORE UPDATE OF status ON catalog_releases
WHEN NEW.status='published' AND OLD.status='staging'
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM catalog_plans WHERE release_id=NEW.id) != NEW.expected_plans
    OR (SELECT COUNT(*) FROM catalog_premium_rates WHERE release_id=NEW.id) != NEW.expected_rates
    OR (SELECT COUNT(*) FROM catalog_sources WHERE release_id=NEW.id) != NEW.expected_sources
    OR (SELECT COUNT(*) FROM catalog_coverage WHERE release_id=NEW.id) != NEW.expected_coverage
    OR (SELECT COUNT(*) FROM catalog_components WHERE release_id=NEW.id) != NEW.expected_components
    OR (SELECT COUNT(*) FROM catalog_plan_counties WHERE release_id=NEW.id) != NEW.expected_counties
    THEN RAISE(ABORT,'Catalog release is incomplete') END;
END;
CREATE TRIGGER catalog_active_insert BEFORE INSERT ON catalog_active
BEGIN SELECT CASE WHEN (SELECT status FROM catalog_releases WHERE id=NEW.release_id) IS NOT 'published'
  THEN RAISE(ABORT,'Catalog release is not published') END; END;
CREATE TRIGGER catalog_active_update BEFORE UPDATE ON catalog_active
BEGIN SELECT CASE WHEN (SELECT status FROM catalog_releases WHERE id=NEW.release_id) IS NOT 'published'
  THEN RAISE(ABORT,'Catalog release is not published') END; END;

CREATE TRIGGER catalog_sources_immutable_insert BEFORE INSERT ON catalog_sources
WHEN (SELECT status FROM catalog_releases WHERE id=NEW.release_id)='published'
BEGIN SELECT RAISE(ABORT,'Published catalog releases are immutable'); END;

CREATE TRIGGER catalog_sources_immutable_update BEFORE UPDATE ON catalog_sources
WHEN (SELECT status FROM catalog_releases WHERE id=OLD.release_id)='published'
BEGIN SELECT RAISE(ABORT,'Published catalog releases are immutable'); END;

CREATE TRIGGER catalog_sources_immutable_delete BEFORE DELETE ON catalog_sources
WHEN (SELECT status FROM catalog_releases WHERE id=OLD.release_id)='published'
BEGIN SELECT RAISE(ABORT,'Published catalog releases are immutable'); END;

CREATE TRIGGER catalog_plans_immutable_insert BEFORE INSERT ON catalog_plans
WHEN (SELECT status FROM catalog_releases WHERE id=NEW.release_id)='published'
BEGIN SELECT RAISE(ABORT,'Published catalog releases are immutable'); END;

CREATE TRIGGER catalog_plans_immutable_update BEFORE UPDATE ON catalog_plans
WHEN (SELECT status FROM catalog_releases WHERE id=OLD.release_id)='published'
BEGIN SELECT RAISE(ABORT,'Published catalog releases are immutable'); END;

CREATE TRIGGER catalog_plans_immutable_delete BEFORE DELETE ON catalog_plans
WHEN (SELECT status FROM catalog_releases WHERE id=OLD.release_id)='published'
BEGIN SELECT RAISE(ABORT,'Published catalog releases are immutable'); END;

CREATE TRIGGER catalog_plan_counties_immutable_insert BEFORE INSERT ON catalog_plan_counties
WHEN (SELECT status FROM catalog_releases WHERE id=NEW.release_id)='published'
BEGIN SELECT RAISE(ABORT,'Published catalog releases are immutable'); END;

CREATE TRIGGER catalog_plan_counties_immutable_update BEFORE UPDATE ON catalog_plan_counties
WHEN (SELECT status FROM catalog_releases WHERE id=OLD.release_id)='published'
BEGIN SELECT RAISE(ABORT,'Published catalog releases are immutable'); END;

CREATE TRIGGER catalog_plan_counties_immutable_delete BEFORE DELETE ON catalog_plan_counties
WHEN (SELECT status FROM catalog_releases WHERE id=OLD.release_id)='published'
BEGIN SELECT RAISE(ABORT,'Published catalog releases are immutable'); END;

CREATE TRIGGER catalog_premium_rates_immutable_insert BEFORE INSERT ON catalog_premium_rates
WHEN (SELECT status FROM catalog_releases WHERE id=NEW.release_id)='published'
BEGIN SELECT RAISE(ABORT,'Published catalog releases are immutable'); END;

CREATE TRIGGER catalog_premium_rates_immutable_update BEFORE UPDATE ON catalog_premium_rates
WHEN (SELECT status FROM catalog_releases WHERE id=OLD.release_id)='published'
BEGIN SELECT RAISE(ABORT,'Published catalog releases are immutable'); END;

CREATE TRIGGER catalog_premium_rates_immutable_delete BEFORE DELETE ON catalog_premium_rates
WHEN (SELECT status FROM catalog_releases WHERE id=OLD.release_id)='published'
BEGIN SELECT RAISE(ABORT,'Published catalog releases are immutable'); END;

CREATE TRIGGER catalog_components_immutable_insert BEFORE INSERT ON catalog_components
WHEN (SELECT status FROM catalog_releases WHERE id=NEW.release_id)='published'
BEGIN SELECT RAISE(ABORT,'Published catalog releases are immutable'); END;

CREATE TRIGGER catalog_components_immutable_update BEFORE UPDATE ON catalog_components
WHEN (SELECT status FROM catalog_releases WHERE id=OLD.release_id)='published'
BEGIN SELECT RAISE(ABORT,'Published catalog releases are immutable'); END;

CREATE TRIGGER catalog_components_immutable_delete BEFORE DELETE ON catalog_components
WHEN (SELECT status FROM catalog_releases WHERE id=OLD.release_id)='published'
BEGIN SELECT RAISE(ABORT,'Published catalog releases are immutable'); END;

CREATE TRIGGER catalog_coverage_immutable_insert BEFORE INSERT ON catalog_coverage
WHEN (SELECT status FROM catalog_releases WHERE id=NEW.release_id)='published'
BEGIN SELECT RAISE(ABORT,'Published catalog releases are immutable'); END;

CREATE TRIGGER catalog_coverage_immutable_update BEFORE UPDATE ON catalog_coverage
WHEN (SELECT status FROM catalog_releases WHERE id=OLD.release_id)='published'
BEGIN SELECT RAISE(ABORT,'Published catalog releases are immutable'); END;

CREATE TRIGGER catalog_coverage_immutable_delete BEFORE DELETE ON catalog_coverage
WHEN (SELECT status FROM catalog_releases WHERE id=OLD.release_id)='published'
BEGIN SELECT RAISE(ABORT,'Published catalog releases are immutable'); END;

CREATE TRIGGER catalog_release_immutable BEFORE UPDATE ON catalog_releases WHEN OLD.status='published' BEGIN SELECT RAISE(ABORT,'Published catalog releases are immutable'); END;
