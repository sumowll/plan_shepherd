-- Publication must pass the staging count checks. A direct insert cannot bypass them.
CREATE TRIGGER catalog_release_requires_staging BEFORE INSERT ON catalog_releases
WHEN NEW.status IS NOT 'staging'
BEGIN SELECT RAISE(ABORT,'Catalog releases must first be staged'); END;

-- An UPDATE moving a staging row into a published release is also an insertion
-- into that immutable release. The original OLD-release guards remain in force.
CREATE TRIGGER catalog_sources_immutable_target BEFORE UPDATE OF release_id ON catalog_sources
WHEN (SELECT status FROM catalog_releases WHERE id=NEW.release_id)='published'
BEGIN SELECT RAISE(ABORT,'Published catalog releases are immutable'); END;

CREATE TRIGGER catalog_plans_immutable_target BEFORE UPDATE OF release_id ON catalog_plans
WHEN (SELECT status FROM catalog_releases WHERE id=NEW.release_id)='published'
BEGIN SELECT RAISE(ABORT,'Published catalog releases are immutable'); END;

CREATE TRIGGER catalog_plan_counties_immutable_target BEFORE UPDATE OF release_id ON catalog_plan_counties
WHEN (SELECT status FROM catalog_releases WHERE id=NEW.release_id)='published'
BEGIN SELECT RAISE(ABORT,'Published catalog releases are immutable'); END;

CREATE TRIGGER catalog_premium_rates_immutable_target BEFORE UPDATE OF release_id ON catalog_premium_rates
WHEN (SELECT status FROM catalog_releases WHERE id=NEW.release_id)='published'
BEGIN SELECT RAISE(ABORT,'Published catalog releases are immutable'); END;

CREATE TRIGGER catalog_components_immutable_target BEFORE UPDATE OF release_id ON catalog_components
WHEN (SELECT status FROM catalog_releases WHERE id=NEW.release_id)='published'
BEGIN SELECT RAISE(ABORT,'Published catalog releases are immutable'); END;

CREATE TRIGGER catalog_coverage_immutable_target BEFORE UPDATE OF release_id ON catalog_coverage
WHEN (SELECT status FROM catalog_releases WHERE id=NEW.release_id)='published'
BEGIN SELECT RAISE(ABORT,'Published catalog releases are immutable'); END;
