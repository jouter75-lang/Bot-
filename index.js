// index.js
// Bot migrator seguro: carga plantilla desde URL (JSON), dry-run, confirmación por token,
// crea/actualiza roles y canales. Node 18+, discord.js v14, dotenv.
const { Client, GatewayIntentBits, PermissionsBitField, ChannelType, REST, Routes, SlashCommandBuilder } = require('discord.js');
const fetch = global.fetch;
require('dotenv').config();
const crypto = require('crypto');

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;
const AUDIT_CHANNEL_ID = process.env.AUDIT_CHANNEL_ID || null;
const DRY_RUN_DEFAULT = process.env.DRY_RUN_DEFAULT !== 'false';

if (!TOKEN || !CLIENT_ID) {
  console.error('Faltan BOT_TOKEN o CLIENT_ID en .env');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const pendingTemplates = new Map(); // token -> { template, guildId, createdAt, userId, dryRun }

function makeToken() { return crypto.randomBytes(6).toString('hex'); }
function nowISO() { return new Date().toISOString(); }

function validateTemplate(t) {
  if (typeof t !== 'object' || t === null) return 'Plantilla debe ser un objeto JSON';
  if (t.roles && !Array.isArray(t.roles)) return 'roles debe ser un array';
  if (t.channels && !Array.isArray(t.channels)) return 'channels debe ser un array';
  for (const r of t.roles || []) if (!r.name) return 'Cada role debe tener name';
  for (const c of t.channels || []) if (!c.name || !c.type) return 'Cada canal debe tener name y type';
  return null;
}

async function computePlan(guild, template) {
  const rolesToCreate = [], rolesToUpdate = [], roleMap = new Map();
  for (const r of template.roles || []) {
    const existing = guild.roles.cache.find(x => x.name === r.name);
    roleMap.set(r.name, existing || null);
    if (existing) {
      const diffs = [];
      if (r.hoist !== undefined && !!r.hoist !== existing.hoist) diffs.push('hoist');
      if (r.mentionable !== undefined && !!r.mentionable !== existing.mentionable) diffs.push('mentionable');
      if (r.color && r.color !== existing.color) diffs.push('color');
      if (r.permissions && BigInt(r.permissions) !== BigInt(existing.permissions.bitfield ?? 0)) diffs.push('permissions');
      if (diffs.length) rolesToUpdate.push({ role: existing, diffs, desired: r });
    } else rolesToCreate.push(r);
  }
  const categoriesToCreate = [], categoryMap = new Map();
  for (const c of (template.channels || [])) if (c.type === 'category') {
    const existing = guild.channels.cache.find(ch => ch.type === ChannelType.GuildCategory && ch.name === c.name);
    categoryMap.set(c.name, existing || null);
    if (!existing) categoriesToCreate.push(c);
  }
  const channelsToCreate = [], channelsToUpdate = [];
  for (const c of (template.channels || [])) {
    if (c.type === 'category') continue;
    const typeEnum = c.type === 'text' ? ChannelType.GuildText : c.type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText;
    const existing = guild.channels.cache.find(ch => ch.name === c.name && ch.type === typeEnum);
    if (existing) channelsToUpdate.push({ existing, desired: c });
    else channelsToCreate.push({ desired: c });
  }
  return { rolesToCreate, rolesToUpdate, categoriesToCreate, channelsToCreate, channelsToUpdate, roleMap };
}

async function applyTemplateChanges(guild, template, options = { dryRun: true, archiveOld: true, userId: null }) {
  const log = [], roleMap = new Map();
  // Roles
  for (const r of template.roles || []) {
    const existing = guild.roles.cache.find(x => x.name === r.name);
    if (existing) {
      log.push(`${nowISO()} - Actualizar role: ${r.name} (${existing.id})`);
      if (!options.dryRun) {
        await existing.edit({
          name: r.name,
          color: r.color || existing.color,
          hoist: !!r.hoist,
          mentionable: !!r.mentionable,
          permissions: r.permissions ? BigInt(r.permissions) : existing.permissions
        }, `Migración por ${options.userId || 'script'}`);
      }
      roleMap.set(r.name, existing);
    } else {
      log.push(`${nowISO()} - Crear role: ${r.name}`);
      if (!options.dryRun) {
        const created = await guild.roles.create({
          name: r.name,
          color: r.color || 'Default',
          hoist: !!r.hoist,
          mentionable: !!r.mentionable,
          permissions: r.permissions ? BigInt(r.permissions) : 0n,
          reason: `Migración por ${options.userId || 'script'}`
        });
        roleMap.set(r.name, created);
      } else roleMap.set(r.name, { id: `DRY-${r.name}` });
    }
  }
  // Categories
  const categoryMap = new Map();
  for (const c of template.channels?.filter(ch => ch.type === 'category') || []) {
    const existing = guild.channels.cache.find(ch => ch.type === ChannelType.GuildCategory && ch.name === c.name);
    if (existing) { categoryMap.set(c.name, existing); log.push(`${nowISO()} - Usar categoría existente: ${c.name}`); }
    else { categoryMap.set(c.name, { id: `DRY-CAT-${c.name}` }); log.push(`${nowISO()} - Crear categoría: ${c.name}`); if (!options.dryRun) {
        await guild.channels.create({ name: c.name, type: ChannelType.GuildCategory, reason: `Migración por ${options.userId || 'script'}` });
      }
    }
  }
  // Channels
  for (const ch of template.channels?.filter(ch => ch.type !== 'category') || []) {
    const typeEnum = ch.type === 'text' ? ChannelType.GuildText : ch.type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText;
    const existing = guild.channels.cache.find(x => x.name === ch.name && x.type === typeEnum);
    const parent = ch.parent ? categoryMap.get(ch.parent) : null;
    const overwrites = (ch.permissionOverwrites || []).map(po => {
      const role = roleMap.get(po.roleName);
      if (!role) return null;
      return { id: role.id, allow: po.allow ?? 0, deny: po.deny ?? 0 };
    }).filter(x => x);
    if (existing) {
      log.push(`${nowISO()} - Actualizar canal: ${ch.name} (${existing.id})`);
      if (!options.dryRun) await existing.edit({ name: ch.name, parent: parent ? parent.id : undefined, permissionOverwrites: overwrites.length ? overwrites.map(o => ({ id: o.id, allow: o.allow, deny: o.deny })) : undefined }, `Migración por ${options.userId || 'script'}`);
    } else {
      log.push(`${nowISO()} - Crear canal: ${ch.name} tipo=${ch.type}`);
      if (!options.dryRun) await guild.channels.create({ name: ch.name, type: typeEnum, parent: parent ? parent.id : undefined, permissionOverwrites: overwrites.length ? overwrites.map(o => ({ id: o.id, allow: o.allow, deny: o.deny })) : undefined, reason: `Migración por ${options.userId || 'script'}` });
    }
  }

  // Archivar (renombrar) elementos no presentes en la plantilla en vez de borrarlos
  if (options.archiveOld) {
    const plantillaRoles = new Set((template.roles || []).map(r => r.name));
    for (const r of guild.roles.cache.values()) {
      if (r.managed || r.name === '@everyone') continue;
      if (!plantillaRoles.has(r.name) && !r.name.startsWith('OLD-')) {
        log.push(`${nowISO()} - Archivar role: ${r.name} -> OLD-${r.name}`);
        if (!options.dryRun) try { await r.setName(`OLD-${r.name}`, 'Archivado por migración'); } catch(e){ log.push(`${nowISO()} - ERROR renombrando role ${r.name}: ${e.message}`); }
      }
    }
    const plantillaCanales = new Set((template.channels || []).map(c => c.name));
    for (const ch of guild.channels.cache.values()) {
      if (!plantillaCanales.has(ch.name) && !ch.name.startsWith('OLD-')) {
        log.push(`${nowISO()} - Archivar canal: ${ch.name} -> OLD-${ch.name}`);
        if (!options.dryRun) try { await ch.setName(`OLD-${ch.name}`, 'Archivado por migración'); } catch(e){ log.push(`${nowISO()} - ERROR renombrando canal ${ch.name}: ${e.message}`); }
      }
    }
  }
  return log;
}

// Slash commands registration
const commands = [
  new SlashCommandBuilder().setName('load-template').setDescription('Carga y muestra un resumen de una plantilla JSON pública').addStringOption(opt => opt.setName('url').setDescription('URL pública de la plantilla JSON').setRequired(true)).addBooleanOption(opt => opt.setName('dry_run').setDescription('Solo previsualizar')),
  new SlashCommandBuilder().setName('apply-template').setDescription('Aplica una plantilla previamente cargada con token').addStringOption(opt => opt.setName('token').setDescription('Token de confirmación').setRequired(true))
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    if (GUILD_ID) await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    else await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Comandos registrados');
  } catch (err) { console.error('Error registrando comandos:', err); }
}

client.once('ready', async () => { console.log(`Conectado como ${client.user.tag}`); await registerCommands(); });

client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;
  const member = interaction.member;
  const allowed = member.permissions.has(PermissionsBitField.Flags.ManageGuild) || member.permissions.has(PermissionsBitField.Flags.Administrator);
  if (!allowed) return interaction.reply({ content: 'Necesitas permisos de Administrador / Manage Server.', ephemeral: true });

  if (interaction.commandName === 'load-template') {
    const url = interaction.options.getString('url', true);
    const dryRun = interaction.options.getBoolean('dry_run') ?? DRY_RUN_DEFAULT;
    await interaction.deferReply({ ephemeral: true });
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Error al descargar plantilla: ${res.status}`);
      const template = await res.json();
      const err = validateTemplate(template);
      if (err) return interaction.editReply({ content: `Plantilla inválida: ${err}` });
      const guild = await interaction.guild.fetch();
      const plan = await computePlan(guild, template);
      const token = makeToken();
      pendingTemplates.set(token, { template, guildId: interaction.guildId, createdAt: Date.now(), userId: interaction.user.id, dryRun });
      setTimeout(() => pendingTemplates.delete(token), 10 * 60 * 1000);
      const summary = [
        `Plantilla cargada.`,
        `Roles a crear: ${plan.rolesToCreate.length}`,
        `Roles a actualizar: ${plan.rolesToUpdate.length}`,
        `Categorías a crear: ${plan.categoriesToCreate.length}`,
        `Canales a crear: ${plan.channelsToCreate.length}`,
        `Canales a actualizar: ${plan.channelsToUpdate.length}`,
        `Token (10m): ${token}`,
        `Para aplicar: /apply-template token:${token}`,
        `dry-run: ${dryRun ? 'sí' : 'no'}`
      ].join('\n');
      await interaction.editReply({ content: summary });
      if (AUDIT_CHANNEL_ID) try { const ch = await interaction.guild.channels.fetch(AUDIT_CHANNEL_ID); ch.send(`Usuario ${interaction.user.tag} cargó plantilla ${url}. Token: ${token}\n${summary}`); } catch (_) {}
    } catch (e) { await interaction.editReply({ content: `Error: ${e.message}` }); }
  } else if (interaction.commandName === 'apply-template') {
    const token = interaction.options.getString('token', true);
    await interaction.deferReply({ ephemeral: true });
    const pending = pendingTemplates.get(token);
    if (!pending) return interaction.editReply({ content: 'Token inválido o expirado.' });
    if (pending.guildId !== interaction.guildId) return interaction.editReply({ content: 'La plantilla fue cargada para otro servidor.' });
    const guild = await interaction.guild.fetch();
    const logs = await applyTemplateChanges(guild, pending.template, { dryRun: pending.dryRun, archiveOld: true, userId: interaction.user.id });
    pendingTemplates.delete(token);
    const reply = [`Aplicación completada. dry-run=${pending.dryRun ? 'sí' : 'no'}`, ...logs].slice(0, 140).join('\n');
    await interaction.editReply({ content: reply });
    if (AUDIT_CHANNEL_ID) try { const ch = await interaction.guild.channels.fetch(AUDIT_CHANNEL_ID); ch.send(`Usuario ${interaction.user.tag} aplicó plantilla. Token: ${token}\nLogs:\n${logs.join('\n')}`); } catch (_) {}
  }
});

client.login(TOKEN);