// JobScorer — Phase 2 ships a deterministic stand-in. The real AI scorer
// (Claude) replaces this in Phase 3; the interface stays unchanged.
//
// Stand-in algorithm:
//   - Preferred-location match: +25 if any preferredLocation appears in the
//     job's location string (case-insensitive, substring).
//   - Title alignment: +20 if any token in profile.currentTitle matches
//     a token in the job title.
//   - Skill overlap: +1 per shared token (cap 30) between job.requiredSkills
//     and profile-derived tokens (currentTitle + summary).
//   - Salary fit: +10 if the job's salary range overlaps profile's expected.
//   - Floor: 30; ceiling: 100.
//
// This is intentionally rough; it is enough to route the engine toward
// reasonable applications during the Phase 2 manual run.

import type { JobScorer } from './interfaces.js';
import type { AdapterProfileSlice } from '../types/adapter.js';
import type { DiscoveredJob } from '../types/discovery.js';

export class DefaultJobScorer implements JobScorer {
  scoreBatch(input: {
    userId: string;
    tenantId: string;
    profile: AdapterProfileSlice;
    jobs: ReadonlyArray<DiscoveredJob>;
  }): Promise<ReadonlyArray<{ externalId: string; score: number; reasoning: string }>> {
    const profileTokens = new Set<string>([
      ...(input.profile.currentTitle ? tokenize(input.profile.currentTitle) : []),
      ...(input.profile.summary ? tokenize(input.profile.summary) : []),
    ]);
    const out = input.jobs.map((j) => {
      let score = 30;
      const reasons: string[] = [];

      if (input.profile.preferredLocations.length > 0 && j.location) {
        const loc = j.location.toLowerCase();
        if (input.profile.preferredLocations.some((p) => loc.includes(p.toLowerCase()))) {
          score += 25;
          reasons.push('location_match');
        }
      }

      if (input.profile.currentTitle) {
        const titleTokens = new Set(tokenize(input.profile.currentTitle));
        const jobTokens = tokenize(j.title);
        if (jobTokens.some((t) => titleTokens.has(t))) {
          score += 20;
          reasons.push('title_alignment');
        }
      }

      let overlap = 0;
      for (const skill of j.requiredSkills) {
        if (profileTokens.has(skill.toLowerCase())) overlap++;
      }
      score += Math.min(overlap, 30);
      if (overlap > 0) reasons.push(`skills:${overlap.toString()}`);

      if (
        input.profile.expectedSalaryMin !== null &&
        input.profile.expectedSalaryMax !== null &&
        j.salaryMin !== null &&
        j.salaryMax !== null
      ) {
        const overlapsMin = j.salaryMax >= input.profile.expectedSalaryMin;
        const overlapsMax = j.salaryMin <= input.profile.expectedSalaryMax;
        if (overlapsMin && overlapsMax) {
          score += 10;
          reasons.push('salary_fit');
        }
      }

      score = Math.min(100, Math.max(0, score));
      return {
        externalId: j.externalId,
        score,
        reasoning: reasons.length > 0 ? `heuristic:${reasons.join(',')}` : 'baseline',
      };
    });
    return Promise.resolve(out);
  }
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9+#./ -]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && t.length < 32);
}
