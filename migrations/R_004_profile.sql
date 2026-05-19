-- =============================================================================
-- R_004 - profile - collaborative roles with multi-parent inheritance (repeatable)
-- =============================================================================

truncate profile cascade;

insert into profile (name, label, description, inheritance) values
  ('creative', 'Creative', 'Creative collaboration profile - innovative, expressive, imaginative', array['collaboration']),
  ('developer', 'Developer', 'Software development collaboration profile - clean, systematic, maintainable', array['engineer']),
  ('engineer', 'Engineer', 'Technical engineering collaboration profile - focused, competent, authentic', array['collaboration']),
  ('humanist', 'Humanist', 'Liberal arts and humanistic collaboration profile - thoughtful, analytical, expressive', array['collaboration']),
  ('researcher', 'Researcher', 'Academic research collaboration profile - rigorous, methodical, evidence-based', array['collaboration']),
  ('translator', 'Translator', 'Professional translation collaboration profile - precise, culturally aware, systematic', array['collaboration']),
  ('collaboration', 'Collaboration', 'Shared collaboration context and methodology', array['infrastructure', 'initialization', 'memory', 'monitoring', 'temporal']),
  ('infrastructure', 'Infrastructure', 'Shared infrastructure context and methodology', array[]::text[]),
  ('initialization', 'Initialization', 'Framework initialization and operations context', array[]::text[]),
  ('memory', 'Memory', 'Shared memory context and cache operations', array[]::text[]),
  ('monitoring', 'Monitoring', 'Shared monitoring observations for behavioral diagnostics', array[]::text[]),
  ('temporal', 'Temporal', 'Temporal awareness context for framework operations', array[]::text[]);
