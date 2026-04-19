import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';
import type { SkillManifest } from './types.js';
import { logger } from '../utils/logger.js';

export class SkillLoader {
  private skillsDir: string;
  private manifests: Map<string, SkillManifest> = new Map();

  constructor(skillsDir?: string) {
    this.skillsDir = skillsDir || join(getMercuryHome(), 'skills');
  }

  discover(): SkillManifest[] {
    this.manifests.clear();
    if (!existsSync(this.skillsDir)) {
      mkdirSync(this.skillsDir, { recursive: true });
      this.seedTemplate();
      return [];
    }

    const entries = readdirSync(this.skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
      const manifestPath = join(this.skillsDir, entry.name, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const raw = readFileSync(manifestPath, 'utf-8');
        const manifest: SkillManifest = JSON.parse(raw);
        this.manifests.set(manifest.name, manifest);
        logger.info({ skill: manifest.name }, 'Skill discovered');
      } catch (err) {
        logger.warn({ dir: entry.name, err }, 'Failed to load skill manifest');
      }
    }

    return [...this.manifests.values()];
  }

  getManifest(name: string): SkillManifest | undefined {
    return this.manifests.get(name);
  }

  getAllManifests(): SkillManifest[] {
    return [...this.manifests.values()];
  }

  private seedTemplate(): void {
    const templateDir = join(this.skillsDir, '_template');
    mkdirSync(templateDir, { recursive: true });

    const manifest: SkillManifest = {
      name: 'template-skill',
      version: '0.1.0',
      description: 'A template skill for Mercury',
      triggers: ['template'],
      capabilities: ['example'],
    };

    writeFileSync(
      join(templateDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8'
    );

    writeFileSync(
      join(templateDir, 'skill.md'),
      '# Template Skill\n\nThis is a template skill for Mercury.\n\n## What It Does\nDescribe what this skill enables Mercury to do.\n',
      'utf-8'
    );

    logger.info('Seeded template skill');
  }
}