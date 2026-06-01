// Idempotent seed: static reference data only. Never inserts user PII.
// Run via `pnpm db:seed`. CI runs this against a fresh PG to verify.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ROLES = [
  { key: 'owner', label: 'Owner' },
  { key: 'viewer', label: 'Viewer' },
  { key: 'automation_bot', label: 'Automation Bot' },
  { key: 'support', label: 'Support Agent' },
  { key: 'admin', label: 'Tenant Admin' },
];

const PERMISSIONS = [
  { key: 'profile.edit', label: 'Edit profile' },
  { key: 'resume.edit.global', label: 'Edit resumes globally' },
  { key: 'resume.edit.linkedin', label: 'Edit LinkedIn resume' },
  { key: 'resume.edit.naukri', label: 'Edit Naukri resume' },
  { key: 'resume.edit.indeed', label: 'Edit Indeed resume' },
  { key: 'resume.edit.internshala', label: 'Edit Internshala resume' },
  { key: 'resume.edit.glassdoor', label: 'Edit Glassdoor resume' },
  { key: 'resume.edit.foundit', label: 'Edit Foundit resume' },
  { key: 'resume.edit.wellfound', label: 'Edit Wellfound resume' },
  { key: 'resume.edit.upwork', label: 'Edit Upwork resume' },
  { key: 'platform.connect', label: 'Connect platform accounts' },
  { key: 'platform.disconnect', label: 'Disconnect platform accounts' },
  { key: 'run.start', label: 'Start runs' },
  { key: 'run.stop', label: 'Stop runs' },
  { key: 'ai.tailor.global', label: 'AI tailoring globally' },
  { key: 'optimization.suggest', label: 'Receive optimization suggestions' },
  { key: 'admin.tenant', label: 'Manage tenant settings' },
];

const PLATFORMS = [
  { key: 'linkedin', label: 'LinkedIn', baseUrl: 'https://www.linkedin.com', ordinal: 1 },
  { key: 'naukri', label: 'Naukri', baseUrl: 'https://www.naukri.com', ordinal: 2 },
  { key: 'indeed', label: 'Indeed', baseUrl: 'https://www.indeed.com', ordinal: 3 },
  { key: 'internshala', label: 'Internshala', baseUrl: 'https://internshala.com', ordinal: 4 },
  { key: 'glassdoor', label: 'Glassdoor', baseUrl: 'https://www.glassdoor.com', ordinal: 5 },
  { key: 'foundit', label: 'Foundit', baseUrl: 'https://www.foundit.in', ordinal: 6 },
  { key: 'wellfound', label: 'Wellfound', baseUrl: 'https://wellfound.com', ordinal: 7 },
  { key: 'upwork', label: 'Upwork', baseUrl: 'https://www.upwork.com', ordinal: 8 },
];

async function main(): Promise<void> {
  for (const r of ROLES) {
    await prisma.role.upsert({
      where: { key: r.key },
      update: { label: r.label },
      create: r,
    });
  }
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: p.key },
      update: { label: p.label },
      create: p,
    });
  }
  for (const pf of PLATFORMS) {
    await prisma.platform.upsert({
      where: { key: pf.key },
      update: { label: pf.label, baseUrl: pf.baseUrl, ordinal: pf.ordinal, enabled: true },
      create: { ...pf, enabled: true },
    });
  }
  // eslint-disable-next-line no-console
  console.log(`seed ok: ${ROLES.length} roles, ${PERMISSIONS.length} permissions, ${PLATFORMS.length} platforms`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
