/**
 * Step: register — Write channel registration config, create group folders.
 *
 * Accepts --channel to specify the messaging platform (whatsapp, telegram, slack, discord).
 * Uses parameterized SQL queries to prevent injection.
 */
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from '../src/config.ts';
import { getRegisteredGroup, initDatabase, setRegisteredGroup } from '../src/db.ts';
import { isValidGroupFolder } from '../src/group-folder.ts';
import { logger } from '../src/logger.ts';
import { ContainerConfig } from '../src/types.ts';
import { emitStatus } from './status.ts';

interface RegisterArgs {
  jid: string;
  name: string;
  trigger: string;
  folder: string;
  channel: string;
  requiresTrigger: boolean;
  isMain: boolean;
  assistantName: string;
  containerConfig?: string; // JSON string for ContainerConfig
}

function parseArgs(args: string[]): RegisterArgs {
  const result: RegisterArgs = {
    jid: '',
    name: '',
    trigger: '',
    folder: '',
    channel: 'whatsapp', // backward-compat: pre-refactor installs omit --channel
    requiresTrigger: true,
    isMain: false,
    assistantName: 'Andy',
    containerConfig: undefined,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--jid':
        result.jid = args[++i] || '';
        break;
      case '--name':
        result.name = args[++i] || '';
        break;
      case '--trigger':
        result.trigger = args[++i] || '';
        break;
      case '--folder':
        result.folder = args[++i] || '';
        break;
      case '--channel':
        result.channel = (args[++i] || '').toLowerCase();
        break;
      case '--no-trigger-required':
        result.requiresTrigger = false;
        break;
      case '--is-main':
        result.isMain = true;
        break;
      case '--assistant-name':
        result.assistantName = args[++i] || 'Andy';
        break;
      case '--container-config':
        result.containerConfig = args[++i] || '';
        break;
    }
  }

  return result;
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const parsed = parseArgs(args);

  if (!parsed.jid || !parsed.name || !parsed.trigger || !parsed.folder) {
    emitStatus('REGISTER_CHANNEL', {
      STATUS: 'failed',
      ERROR: 'missing_required_args',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  if (!isValidGroupFolder(parsed.folder)) {
    emitStatus('REGISTER_CHANNEL', {
      STATUS: 'failed',
      ERROR: 'invalid_folder',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  logger.info({ ...parsed }, 'Registering channel');

  // Ensure data and store directories exist (store/ may not exist on
  // fresh installs that skip WhatsApp auth, which normally creates it)
  fs.mkdirSync(path.join(projectRoot, 'data'), { recursive: true });
  fs.mkdirSync(STORE_DIR, { recursive: true });

  // Initialize database (creates schema + runs migrations)
  initDatabase();

  // Parse containerConfig: prefer --container-config flag, then fall back to
  // groups/<folder>/container-config.json if present.
  let containerConfig: ContainerConfig | undefined;
  if (parsed.containerConfig) {
    try {
      containerConfig = JSON.parse(parsed.containerConfig) as ContainerConfig;
    } catch {
      logger.error({ raw: parsed.containerConfig }, 'Invalid --container-config JSON');
      emitStatus('REGISTER_CHANNEL', {
        STATUS: 'failed',
        ERROR: 'invalid_container_config_json',
        LOG: 'logs/setup.log',
      });
      process.exit(4);
    }
  } else {
    // Load from groups/main/container-config.json — the canonical workspace mount config,
    // tracked by git and shared across all groups.
    const configFile = path.join(projectRoot, 'groups', 'main', 'container-config.json');
    if (fs.existsSync(configFile)) {
      try {
        containerConfig = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as ContainerConfig;
        logger.info({ configFile }, 'Loaded containerConfig from groups/main/container-config.json');
      } catch {
        logger.warn({ configFile }, 'Failed to parse container-config.json — skipping');
      }
    }
  }

  // If only updating containerConfig on an existing group, preserve all other fields
  const existing = getRegisteredGroup(parsed.jid);
  const groupToSave = existing && containerConfig && !parsed.name
    ? { ...existing, containerConfig }
    : {
        name: parsed.name,
        folder: parsed.folder,
        trigger: parsed.trigger,
        added_at: new Date().toISOString(),
        requiresTrigger: parsed.requiresTrigger,
        isMain: parsed.isMain,
        containerConfig,
      };

  setRegisteredGroup(parsed.jid, groupToSave);

  logger.info('Wrote registration to SQLite');

  // Create group folders
  fs.mkdirSync(path.join(projectRoot, 'groups', parsed.folder, 'logs'), {
    recursive: true,
  });

  // Create CLAUDE.md in the new group folder from template if it doesn't exist.
  // The agent runs with CWD=/workspace/group and loads CLAUDE.md from there.
  // Never overwrite an existing CLAUDE.md — users customize these extensively
  // (persona, workspace structure, communication rules, family context, etc.)
  // and a stock template replacement would destroy that work.
  const groupClaudeMdPath = path.join(
    projectRoot,
    'groups',
    parsed.folder,
    'CLAUDE.md',
  );
  if (!fs.existsSync(groupClaudeMdPath)) {
    const templatePath = parsed.isMain
      ? path.join(projectRoot, 'groups', 'main', 'CLAUDE.md')
      : path.join(projectRoot, 'groups', 'global', 'CLAUDE.md');
    if (fs.existsSync(templatePath)) {
      fs.copyFileSync(templatePath, groupClaudeMdPath);
      logger.info(
        { file: groupClaudeMdPath, template: templatePath },
        'Created CLAUDE.md from template',
      );
    }
  }

  // Update assistant name in CLAUDE.md files if different from default
  let nameUpdated = false;
  if (parsed.assistantName !== 'Andy') {
    logger.info(
      { from: 'Andy', to: parsed.assistantName },
      'Updating assistant name',
    );

    const groupsDir = path.join(projectRoot, 'groups');
    const mdFiles = fs
      .readdirSync(groupsDir)
      .map((d) => path.join(groupsDir, d, 'CLAUDE.md'))
      .filter((f) => fs.existsSync(f));

    for (const mdFile of mdFiles) {
      if (fs.existsSync(mdFile)) {
        let content = fs.readFileSync(mdFile, 'utf-8');
        content = content.replace(/^# Andy$/m, `# ${parsed.assistantName}`);
        content = content.replace(
          /You are Andy/g,
          `You are ${parsed.assistantName}`,
        );
        fs.writeFileSync(mdFile, content);
        logger.info({ file: mdFile }, 'Updated CLAUDE.md');
      }
    }

    // Update .env
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      let envContent = fs.readFileSync(envFile, 'utf-8');
      if (envContent.includes('ASSISTANT_NAME=')) {
        envContent = envContent.replace(
          /^ASSISTANT_NAME=.*$/m,
          `ASSISTANT_NAME="${parsed.assistantName}"`,
        );
      } else {
        envContent += `\nASSISTANT_NAME="${parsed.assistantName}"`;
      }
      fs.writeFileSync(envFile, envContent);
    } else {
      fs.writeFileSync(envFile, `ASSISTANT_NAME="${parsed.assistantName}"\n`);
    }
    logger.info('Set ASSISTANT_NAME in .env');
    nameUpdated = true;
  }

  emitStatus('REGISTER_CHANNEL', {
    JID: parsed.jid,
    NAME: parsed.name,
    FOLDER: parsed.folder,
    CHANNEL: parsed.channel,
    TRIGGER: parsed.trigger,
    REQUIRES_TRIGGER: parsed.requiresTrigger,
    ASSISTANT_NAME: parsed.assistantName,
    NAME_UPDATED: nameUpdated,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
