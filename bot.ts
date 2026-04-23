// ================================================================
// VCT Hub Bot — complete single file
// Install: npm install discord.js drizzle-orm pg express cors
//          @napi-rs/canvas pino pino-http pino-pretty
// Env:     DISCORD_BOT_TOKEN  DATABASE_URL  PORT
// ================================================================

import {
  Client, GatewayIntentBits, Events, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ActionRowBuilder, StringSelectMenuBuilder,
  ButtonBuilder, ButtonStyle, EmbedBuilder,
  ChannelType, MessageFlags, AttachmentBuilder,
  type GuildMember, type TextChannel, type Interaction,
} from "discord.js";
import { drizzle } from "drizzle-orm/node-postgres";
import pkg from "pg";
const { Pool } = pkg;
import {
  pgTable, serial, text, timestamp, boolean,
  integer, uniqueIndex, jsonb,
} from "drizzle-orm/pg-core";
import { and, asc, desc, eq } from "drizzle-orm";
import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import { EventEmitter } from "node:events";
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import pino from "pino";
import pinoHttp from "pino-http";

// ── Logger ────────────────────────────────────────────────────────
const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: ["req.headers.authorization", "req.headers.cookie"],
  ...(process.env.NODE_ENV === "production" ? {} : {
    transport: { target: "pino-pretty", options: { colorize: true } },
  }),
});

// ── DB Schema ─────────────────────────────────────────────────────
const tournamentsTable = pgTable("tournaments", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  startTime: timestamp("start_time", { withTimezone: true }).notNull(),
  guildId: text("guild_id").notNull(),
  signupChannelId: text("signup_channel_id").notNull(),
  signupMessageId: text("signup_message_id"),
  managerRoleId: text("manager_role_id").notNull(),
  premiumRoleId: text("premium_role_id"),
  platform: text("platform").notNull().default("Crossplay"),
  rulesUrl: text("rules_url"),
  status: text("status").notNull().default("open"),
  closed: boolean("closed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

const signupsTable = pgTable("signups", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull(),
  teamName: text("team_name").notNull(),
  managerId: text("manager_id").notNull(),
  coManagers: text("co_managers").array().notNull().default([]),
  isPremium: boolean("is_premium").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniq: uniqueIndex("signups_tournament_manager_uniq").on(t.tournamentId, t.managerId),
}));

const groupsTable = pgTable("groups", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull(),
  data: jsonb("data").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

const fixturesTable = pgTable("fixtures", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull(),
  kind: text("kind").notNull().default("group"),
  data: jsonb("data").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

type Tournament = typeof tournamentsTable.$inferSelect;
type Signup = typeof signupsTable.$inferSelect;

// ── DB Connection ─────────────────────────────────────────────────
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema: { tournamentsTable, signupsTable, groupsTable, fixturesTable } });

// ── SSE Event Bus ─────────────────────────────────────────────────
type SignupEvent = { type: "signup-changed"; tournamentType?: string; tournamentId?: number };
const signupEvents = new EventEmitter();
signupEvents.setMaxListeners(0);

// ── Tournament Types ──────────────────────────────────────────────
type TournamentType = "NH" | "HR" | "CC" | "LN";
function isValidType(t: string): t is TournamentType { return ["NH","HR","CC","LN"].includes(t); }

// ── Time Gates ────────────────────────────────────────────────────
function setHM(base: Date, h: number, m: number): Date {
  const d = new Date(base); d.setHours(h, m, 0, 0); return d;
}
function getDeadlines(type: TournamentType, start: Date) {
  switch (type) {
    case "NH": case "HR":
      return { signupPremium: setHM(start,19,0), signupNormal: setHM(start,18,30),
               pulloutPremium: setHM(start,18,55), pulloutNormal: setHM(start,18,30) };
    case "CC":
      return { signupPremium: setHM(start,20,45), signupNormal: setHM(start,20,15),
               pulloutPremium: setHM(start,20,45), pulloutNormal: setHM(start,20,15) };
    case "LN":
      return { signupPremium: setHM(start,22,45), signupNormal: setHM(start,22,15),
               pulloutPremium: setHM(start,22,45), pulloutNormal: setHM(start,22,15) };
  }
}
function isSameDay(a: Date, b: Date) {
  return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
}
function canSignup(type: TournamentType, start: Date, isPremium: boolean, now=new Date()) {
  if (!isSameDay(now,start)) return { allowed: true };
  const d = getDeadlines(type,start);
  if (now > (isPremium ? d.signupPremium : d.signupNormal)) return { allowed:false, reason:"Signups are now closed." };
  return { allowed: true };
}
function canPullout(type: TournamentType, start: Date, isPremium: boolean, now=new Date()) {
  if (!isSameDay(now,start)) return { allowed: true };
  const d = getDeadlines(type,start);
  if (now > (isPremium ? d.pulloutPremium : d.pulloutNormal)) return { allowed:false, reason:"You cannot pull out after the deadline." };
  return { allowed: true };
}

// ── Fixture Times ─────────────────────────────────────────────────
const FIXTURE_TIMES: Record<TournamentType,[string,string,string]> = {
  NH: ["20:00","20:25","20:50"],
  HR: ["20:00","20:25","20:50"],
  CC: ["21:15","21:40","22:05"],
  LN: ["23:15","23:40","00:05"],
};

// ── Discord Embed ─────────────────────────────────────────────────
const NBSP = "\u00A0", BLANK = "\u200B";

function buildSignupEmbed(tournament: Tournament, signups: Signup[]) {
  const lines = signups.map((s,i) => {
    const co = s.coManagers.length ? ` / ${s.coManagers.map(c=>`<@${c}>`).join(" / ")}` : "";
    return `\`${String(i+1).padStart(2," ")}.\`${NBSP}**${s.teamName}**${NBSP}—${NBSP}<@${s.managerId}>${co}${s.isPremium?" 💎":""}`;
  });
  const embed = new EmbedBuilder().setColor(0xfacc15);
  embed.addFields({ name:"👥 Participants", value: lines.length ? lines.join("\n") : "*No teams signed up yet.*", inline:false });
  if (tournament.premiumRoleId) {
    embed.addFields({ name:BLANK, value:[
      "**💎 VCT Premium**",
      `Priority signup enabled for <@&${tournament.premiumRoleId}>`,
      "• Premium teams appear at the top",
      "• Can sign up later than normal users",
    ].join("\n"), inline:false });
  }
  embed.addFields({ name:BLANK, value:[
    "**📜 Tournament Rules**",
    tournament.rulesUrl ? `[Click here to read the full ruleset](${tournament.rulesUrl})` : "Check the rules channel for the full ruleset.",
  ].join("\n"), inline:false });
  embed.addFields({ name:BLANK, value:[
    "**ℹ️ How To Enter**",
    "Click **Sign Up** to enter",
    "Click **Pull Out** to leave",
    "Use **More Actions** to add a co-manager or change your team name",
  ].join("\n"), inline:false });
  embed.addFields({ name:BLANK, value:[
    tournament.closed ? "**🔒 Status**" : "**✅ Status**",
    tournament.closed ? "Signups are **CLOSED**" : "Signups are **OPEN**",
  ].join("\n"), inline:false });
  embed.setFooter({ text:"⚡ Powered by VCT Hub" }).setTimestamp(new Date());
  return embed;
}

function buildSignupButtons(closed: boolean, tournamentId: number, rulesUrl?: string|null) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`signup:enter:${tournamentId}`).setLabel("Sign Up").setEmoji("✅").setStyle(ButtonStyle.Primary).setDisabled(closed),
    new ButtonBuilder().setCustomId(`signup:withdraw:${tournamentId}`).setLabel("Pull Out").setEmoji("❌").setStyle(ButtonStyle.Danger).setDisabled(closed),
    new ButtonBuilder().setCustomId(`signup:more:${tournamentId}`).setLabel("More Actions").setEmoji("⚙️").setStyle(ButtonStyle.Secondary).setDisabled(closed),
  );
  if (rulesUrl) row.addComponents(new ButtonBuilder().setLabel("Tourney Rules").setEmoji("⚠️").setStyle(ButtonStyle.Link).setURL(rulesUrl));
  return row;
}

// ── Canvas Helpers ────────────────────────────────────────────────
const W=1100, PAD=48, GOLD="#facc15", BG="#0b0d12", PANEL="#161a23", PANEL2="#1d2230", TEXTC="#f1f5f9", MUTED="#9ca3af";

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r);
  ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r);
  ctx.arcTo(x,y,x+w,y,r); ctx.closePath();
}
function ellipsis(ctx: SKRSContext2D, text: string, x: number, y: number, maxW: number, align: CanvasTextAlign="left") {
  ctx.textAlign=align;
  let t=text;
  if (ctx.measureText(t).width<=maxW) { ctx.fillText(t,x,y); return; }
  while (t.length>1 && ctx.measureText(t+"…").width>maxW) t=t.slice(0,-1);
  ctx.fillText(t+"…",x,y);
}

// ── Fixture Card ──────────────────────────────────────────────────
interface FixtureGame { home:string; away:string; homePremium?:boolean; awayPremium?:boolean }
interface FixtureGroup { name:string; games:FixtureGame[] }

function renderGroupCard(type: TournamentType, title: string, group: FixtureGroup): Buffer {
  const times=FIXTURE_TIMES[type], rows=Math.max(group.games.length,3);
  const HEADER_H=140, ROW_H=130, FOOTER_H=70, H=HEADER_H+rows*ROW_H+FOOTER_H+PAD;
  const canvas=createCanvas(W,H), ctx=canvas.getContext("2d");

  ctx.fillStyle=BG; ctx.fillRect(0,0,W,H);
  ctx.fillStyle=GOLD; ctx.fillRect(0,0,W,6);
  ctx.fillStyle=PANEL; roundRect(ctx,PAD,PAD,W-PAD*2,HEADER_H-20,18); ctx.fill();
  ctx.fillStyle=GOLD; roundRect(ctx,PAD+28,PAD+24,180,64,12); ctx.fill();
  ctx.fillStyle=BG; ctx.font="700 36px sans-serif"; ctx.textBaseline="middle"; ctx.textAlign="center";
  ctx.fillText(`GROUP ${group.name}`,PAD+28+90,PAD+24+32);
  ctx.textAlign="left"; ctx.fillStyle=TEXTC; ctx.font="700 36px sans-serif";
  ellipsis(ctx,title,PAD+230,PAD+56,W-PAD*2-260);
  ctx.fillStyle=MUTED; ctx.font="500 22px sans-serif";
  ellipsis(ctx,"VCT Hub · Group Stage Fixtures",PAD+230,PAD+92,W-PAD*2-260);

  const rowsY=PAD+HEADER_H;
  for (let i=0;i<rows;i++) {
    const y=rowsY+i*ROW_H, game=group.games[i]??{home:"TBD",away:"TBD"}, time=times[i]??"--:--";
    ctx.fillStyle=i%2===0?PANEL:PANEL2; roundRect(ctx,PAD,y+10,W-PAD*2,ROW_H-20,14); ctx.fill();
    ctx.fillStyle=BG; roundRect(ctx,PAD+24,y+30,150,ROW_H-60,12); ctx.fill();
    ctx.strokeStyle=GOLD; ctx.lineWidth=2; roundRect(ctx,PAD+24,y+30,150,ROW_H-60,12); ctx.stroke();
    ctx.fillStyle=GOLD; ctx.font="700 32px sans-serif"; ctx.textAlign="center"; ctx.textBaseline="middle";
    ctx.fillText(time,PAD+24+75,y+ROW_H/2);
    const matchX=PAD+200, matchW=W-PAD*2-220, cx=matchX+matchW/2;
    ctx.font="700 30px sans-serif"; ctx.fillStyle=TEXTC;
    ctx.textAlign="right"; ellipsis(ctx,game.home+(game.homePremium?"  💎":""),cx-50,y+ROW_H/2,matchW/2-60);
    ctx.textAlign="center"; ctx.fillStyle=MUTED; ctx.font="600 22px sans-serif"; ctx.fillText("VS",cx,y+ROW_H/2);
    ctx.textAlign="left"; ctx.fillStyle=TEXTC; ctx.font="700 30px sans-serif";
    ellipsis(ctx,(game.awayPremium?"💎  ":"")+game.away,cx+50,y+ROW_H/2,matchW/2-60);
    ctx.textAlign="right"; ctx.fillStyle=MUTED; ctx.font="500 18px sans-serif";
    ctx.fillText(`Game ${i+1}`,W-PAD-24,y+ROW_H-28);
  }
  ctx.textAlign="center"; ctx.fillStyle=MUTED; ctx.font="500 22px sans-serif";
  ctx.fillText("⚡ Powered by VCT Hub",W/2,H-PAD/2);
  return canvas.toBuffer("image/png");
}

// ── KO Card ───────────────────────────────────────────────────────
interface KOMatch { home:string; away:string; homeScore?:number|null; awayScore?:number|null; homePremium?:boolean; awayPremium?:boolean }
interface KORound { name:string; matches:KOMatch[] }

function renderKOCard(title: string, round: KORound): Buffer {
  const HEADER_H=130, MATCH_H=110, ROUND_GAP=28, FOOTER_H=70;
  const rows=round.matches.length, H=HEADER_H+rows*(MATCH_H+ROUND_GAP)+PAD+FOOTER_H;
  const WIN_BG="#162a0e", LOSS_BG="#2a0e0e";
  const canvas=createCanvas(W,H), ctx=canvas.getContext("2d");

  ctx.fillStyle=BG; ctx.fillRect(0,0,W,H);
  ctx.fillStyle=GOLD; ctx.fillRect(0,0,W,6);
  ctx.fillStyle=PANEL; roundRect(ctx,PAD,PAD,W-PAD*2,HEADER_H-16,18); ctx.fill();
  ctx.fillStyle=GOLD; roundRect(ctx,PAD+24,PAD+20,220,60,12); ctx.fill();
  ctx.fillStyle=BG; ctx.font="700 30px sans-serif"; ctx.textAlign="center"; ctx.textBaseline="middle";
  ctx.fillText(round.name,PAD+24+110,PAD+50);
  ctx.textAlign="left"; ctx.fillStyle=TEXTC; ctx.font="700 32px sans-serif";
  ellipsis(ctx,title,PAD+270,PAD+42,W-PAD*2-300);
  ctx.fillStyle=MUTED; ctx.font="500 20px sans-serif"; ctx.fillText("VCT Hub · Knockout Stage",PAD+270,PAD+82);

  const bodyY=HEADER_H+PAD/2;
  for (let i=0;i<rows;i++) {
    const m=round.matches[i]!, y=bodyY+i*(MATCH_H+ROUND_GAP);
    const scored=m.homeScore!=null&&m.awayScore!=null;
    const homeWin=scored&&m.homeScore!>m.awayScore!, awayWin=scored&&m.awayScore!>m.homeScore!;
    ctx.fillStyle=i%2===0?PANEL:PANEL2; roundRect(ctx,PAD,y,W-PAD*2,MATCH_H,14); ctx.fill();
    const teamW=(W-PAD*2-100)/2-20, homeX=PAD+20, awayX=homeX+teamW+100, midX=homeX+teamW;
    if (homeWin) { ctx.fillStyle=WIN_BG; roundRect(ctx,homeX-4,y+8,teamW+4,MATCH_H-16,10); ctx.fill(); }
    else if (awayWin) { ctx.fillStyle=LOSS_BG; roundRect(ctx,homeX-4,y+8,teamW+4,MATCH_H-16,10); ctx.fill(); }
    ctx.font="700 28px sans-serif"; ctx.fillStyle=homeWin?GOLD:TEXTC; ctx.textBaseline="middle";
    ellipsis(ctx,(m.homePremium?"💎 ":"")+m.home,homeX+12,y+MATCH_H/2-10,teamW-24,"left");
    if (scored) { ctx.fillStyle=MUTED; ctx.font="500 18px sans-serif"; ctx.textAlign="left"; ctx.fillText(`Score: ${m.homeScore}`,homeX+12,y+MATCH_H/2+18); }
    ctx.fillStyle=BG; roundRect(ctx,midX+16,y+MATCH_H/2-22,68,44,10); ctx.fill();
    ctx.strokeStyle=GOLD; ctx.lineWidth=2; roundRect(ctx,midX+16,y+MATCH_H/2-22,68,44,10); ctx.stroke();
    ctx.fillStyle=GOLD; ctx.font="700 24px sans-serif"; ctx.textAlign="center"; ctx.fillText("VS",midX+50,y+MATCH_H/2);
    if (awayWin) { ctx.fillStyle=WIN_BG; roundRect(ctx,awayX,y+8,teamW+4,MATCH_H-16,10); ctx.fill(); }
    else if (homeWin) { ctx.fillStyle=LOSS_BG; roundRect(ctx,awayX,y+8,teamW+4,MATCH_H-16,10); ctx.fill(); }
    ctx.font="700 28px sans-serif"; ctx.fillStyle=awayWin?GOLD:TEXTC; ctx.textAlign="left";
    ellipsis(ctx,(m.awayPremium?"💎 ":"")+m.away,awayX+12,y+MATCH_H/2-10,teamW-24,"left");
    if (scored) { ctx.fillStyle=MUTED; ctx.font="500 18px sans-serif"; ctx.textAlign="left"; ctx.fillText(`Score: ${m.awayScore}`,awayX+12,y+MATCH_H/2+18); }
    ctx.fillStyle=MUTED; ctx.font="500 18px sans-serif"; ctx.textAlign="right";
    ctx.fillText(`Match ${i+1}`,W-PAD-20,y+MATCH_H-18);
  }
  ctx.textAlign="center"; ctx.fillStyle=MUTED; ctx.font="500 22px sans-serif";
  ctx.fillText("⚡ Powered by VCT Hub",W/2,H-PAD/2+10);
  return canvas.toBuffer("image/png");
}

// ── Bot Helpers ───────────────────────────────────────────────────
let activeClient: Client|null = null;
function getBotClient() { return activeClient; }

function memberHasRole(member: GuildMember, roleId: string|null|undefined) {
  return roleId ? member.roles.cache.has(roleId) : false;
}
async function setManagerTag(member: GuildMember, on: boolean) {
  try {
    const current=member.nickname??member.user.globalName??member.user.username;
    const stripped=current.replace(/\s*\(M\)\s*$/i,"").trim();
    const desired=on?`${stripped} (M)`:stripped;
    if (desired===current||desired.length>32) return;
    await member.setNickname(desired);
  } catch(err) { logger.warn({err,userId:member.id},"Could not update nickname"); }
}
async function refreshSignupMessage(client: Client, tournamentId: number) {
  const [t]=await db.select().from(tournamentsTable).where(eq(tournamentsTable.id,tournamentId));
  if (!t||!t.signupMessageId) return;
  const signups=await db.select().from(signupsTable)
    .where(eq(signupsTable.tournamentId,tournamentId))
    .orderBy(desc(signupsTable.isPremium),asc(signupsTable.createdAt));
  try {
    const channel=await client.channels.fetch(t.signupChannelId);
    if (!channel||channel.type!==ChannelType.GuildText) return;
    const msg=await (channel as TextChannel).messages.fetch(t.signupMessageId);
    await msg.edit({ embeds:[buildSignupEmbed(t,signups)], components:[buildSignupButtons(t.closed,t.id,t.rulesUrl)] });
  } catch(err) { logger.error({err,tournamentId},"Failed to refresh embed"); }
  signupEvents.emit("change",{type:"signup-changed",tournamentType:t.type,tournamentId:t.id});
}

// ── Slash Commands ────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName("tournament").setDescription("Manage tournaments")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s=>s.setName("create").setDescription("Create a new tournament signup")
      .addStringOption(o=>o.setName("type").setDescription("Tournament type").setRequired(true)
        .addChoices({name:"Height Restrictions",value:"HR"},{name:"Non-Height Restrictions",value:"NH"},{name:"Cash Cup",value:"CC"},{name:"Late Night",value:"LN"}))
      .addStringOption(o=>o.setName("title").setDescription("Tournament title").setRequired(true))
      .addStringOption(o=>o.setName("date").setDescription("Date YYYY-MM-DD").setRequired(true))
      .addRoleOption(o=>o.setName("manager_role").setDescription("Required manager role").setRequired(true))
      .addChannelOption(o=>o.setName("channel").setDescription("Signup channel").addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addRoleOption(o=>o.setName("premium_role").setDescription("VCT Premium role (💎 priority)"))
      .addStringOption(o=>o.setName("platform").setDescription("Platform (default: Crossplay)"))
      .addStringOption(o=>o.setName("rules_url").setDescription("Link to tournament rules")))
    .addSubcommand(s=>s.setName("close").setDescription("Close signups").addIntegerOption(o=>o.setName("id").setDescription("Tournament ID").setRequired(true)))
    .addSubcommand(s=>s.setName("open").setDescription("Reopen signups").addIntegerOption(o=>o.setName("id").setDescription("Tournament ID").setRequired(true)))
    .addSubcommand(s=>s.setName("list").setDescription("List all tournaments"))
    .addSubcommand(s=>s.setName("remove").setDescription("Remove a team")
      .addIntegerOption(o=>o.setName("id").setDescription("Tournament ID").setRequired(true))
      .addUserOption(o=>o.setName("manager").setDescription("Manager to remove").setRequired(true))),
].map(c=>c.toJSON());

// ── Bot Start ─────────────────────────────────────────────────────
async function startBot() {
  const token=process.env.DISCORD_BOT_TOKEN;
  if (!token) { logger.warn("DISCORD_BOT_TOKEN not set; bot will not start."); return; }
  const client=new Client({ intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers] });
  activeClient=client;

  client.once(Events.ClientReady, async(c) => {
    logger.info({tag:c.user.tag},"Bot logged in");
    try {
      const rest=new REST({version:"10"}).setToken(token);
      await rest.put(Routes.applicationCommands(c.user.id),{body:commands});
      logger.info("Slash commands registered");
    } catch(err) { logger.error({err},"Failed to register commands"); }

    // Auto-close scheduler
    const tick=async()=>{
      try {
        const now=new Date();
        const open=await db.select().from(tournamentsTable).where(eq(tournamentsTable.closed,false));
        for (const t of open) {
          const start=new Date(t.startTime);
          if (!isSameDay(now,start)) continue;
          const d=getDeadlines(t.type as TournamentType,start);
          if (now>d.signupPremium) {
            await db.update(tournamentsTable).set({closed:true,status:"closed"}).where(eq(tournamentsTable.id,t.id));
            logger.info({tournamentId:t.id},"Auto-closed tournament");
            await refreshSignupMessage(client,t.id);
          }
        }
      } catch(err) { logger.error({err},"Scheduler tick failed"); }
    };
    setInterval(tick,60_000); void tick();
  });

  client.on(Events.InteractionCreate, async(interaction: Interaction)=>{
    try {
      if (interaction.isChatInputCommand()&&interaction.commandName==="tournament") await handleTournamentCommand(client,interaction);
      else if (interaction.isButton()) await handleButton(client,interaction);
      else if (interaction.isStringSelectMenu()) await handleSelectMenu(interaction);
      else if (interaction.isModalSubmit()) await handleModal(client,interaction);
    } catch(err) {
      logger.error({err},"Interaction error");
      if (interaction.isRepliable()&&!interaction.replied&&!interaction.deferred) {
        try { await interaction.reply({content:"Something went wrong. Please try again.",flags:MessageFlags.Ephemeral}); } catch {}
      }
    }
  });

  await client.login(token);
}

// ── /tournament command ───────────────────────────────────────────
async function handleTournamentCommand(client: Client, interaction: import("discord.js").ChatInputCommandInteraction) {
  const sub=interaction.options.getSubcommand();

  if (sub==="create") {
    await interaction.deferReply({flags:MessageFlags.Ephemeral});
    const type=interaction.options.getString("type",true);
    if (!isValidType(type)) { await interaction.editReply("Invalid tournament type."); return; }
    const title=interaction.options.getString("title",true);
    const dateStr=interaction.options.getString("date",true);
    const managerRole=interaction.options.getRole("manager_role",true);
    const channel=interaction.options.getChannel("channel",true);
    const premiumRole=interaction.options.getRole("premium_role");
    const platform=interaction.options.getString("platform")??"Crossplay";
    const rulesUrl=interaction.options.getString("rules_url");
    const startDate=new Date(`${dateStr}T20:00:00`);
    if (Number.isNaN(startDate.getTime())) { await interaction.editReply("Invalid date. Use YYYY-MM-DD."); return; }
    const [created]=await db.insert(tournamentsTable).values({
      type,title,startTime:startDate,guildId:interaction.guildId!,
      signupChannelId:channel.id,managerRoleId:managerRole.id,
      premiumRoleId:premiumRole?.id??null,platform,rulesUrl:rulesUrl??null,
      status:"open",closed:false,
    }).returning();
    if (!created) { await interaction.editReply("Failed to create tournament."); return; }
    const ch=await client.channels.fetch(channel.id);
    if (!ch||ch.type!==ChannelType.GuildText) { await interaction.editReply("Channel is not a text channel."); return; }
    const msg=await (ch as TextChannel).send({embeds:[buildSignupEmbed(created,[])],components:[buildSignupButtons(false,created.id,created.rulesUrl)]});
    await db.update(tournamentsTable).set({signupMessageId:msg.id}).where(eq(tournamentsTable.id,created.id));
    await interaction.editReply(`✅ **${title}** (ID: ${created.id}) created in <#${channel.id}>.`);
    return;
  }
  if (sub==="list") {
    await interaction.deferReply({flags:MessageFlags.Ephemeral});
    const rows=await db.select().from(tournamentsTable).where(eq(tournamentsTable.guildId,interaction.guildId!)).orderBy(desc(tournamentsTable.createdAt)).limit(15);
    if (!rows.length) { await interaction.editReply("No tournaments yet."); return; }
    await interaction.editReply(rows.map(t=>`**${t.id}** · [${t.type}] ${t.title} — ${t.closed?"🔒 closed":"✅ open"} — <#${t.signupChannelId}>`).join("\n"));
    return;
  }
  if (sub==="close"||sub==="open") {
    await interaction.deferReply({flags:MessageFlags.Ephemeral});
    const id=interaction.options.getInteger("id",true), closed=sub==="close";
    await db.update(tournamentsTable).set({closed,status:closed?"closed":"open"}).where(eq(tournamentsTable.id,id));
    await refreshSignupMessage(client,id);
    await interaction.editReply(`Tournament ${id} ${closed?"closed":"reopened"}.`);
    return;
  }
  if (sub==="remove") {
    await interaction.deferReply({flags:MessageFlags.Ephemeral});
    const id=interaction.options.getInteger("id",true);
    const user=interaction.options.getUser("manager",true);
    await db.delete(signupsTable).where(and(eq(signupsTable.tournamentId,id),eq(signupsTable.managerId,user.id)));
    await refreshSignupMessage(client,id);
    await interaction.editReply(`Removed <@${user.id}> from tournament ${id}.`);
    return;
  }
}

// ── Button Handler ────────────────────────────────────────────────
async function handleButton(client: Client, interaction: import("discord.js").ButtonInteraction) {
  const [ns,action,idStr]=interaction.customId.split(":");
  if (ns!=="signup") return;
  const tournamentId=Number(idStr);
  if (Number.isNaN(tournamentId)) return;
  const [t]=await db.select().from(tournamentsTable).where(eq(tournamentsTable.id,tournamentId));
  if (!t) { await interaction.reply({content:"Tournament not found.",flags:MessageFlags.Ephemeral}); return; }
  const member=interaction.member as GuildMember|null;
  if (!member) { await interaction.reply({content:"Could not resolve member info.",flags:MessageFlags.Ephemeral}); return; }
  if (t.closed) { await interaction.reply({content:"Signups are now closed.",flags:MessageFlags.Ephemeral}); return; }
  const isPremium=memberHasRole(member,t.premiumRoleId);

  if (action==="enter") {
    if (!memberHasRole(member,t.managerRoleId)) {
      await interaction.reply({content:"You don't have the required role to sign up.",flags:MessageFlags.Ephemeral}); return;
    }
    const gate=canSignup(t.type as TournamentType,new Date(t.startTime),isPremium);
    if (!gate.allowed) { await interaction.reply({content:gate.reason!,flags:MessageFlags.Ephemeral}); return; }
    const existing=await db.select().from(signupsTable).where(and(eq(signupsTable.tournamentId,tournamentId),eq(signupsTable.managerId,member.id)));
    if (existing.length) { await interaction.reply({content:"You're already signed up.",flags:MessageFlags.Ephemeral}); return; }
    const modal=new ModalBuilder().setCustomId(`signup:modal:${tournamentId}`).setTitle("Enter tournament");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("teamName").setLabel("Team name").setPlaceholder("Enter your team name here").setStyle(TextInputStyle.Short).setMinLength(2).setMaxLength(64).setRequired(true)
    ));
    await interaction.showModal(modal); return;
  }
  if (action==="withdraw") {
    const gate=canPullout(t.type as TournamentType,new Date(t.startTime),isPremium);
    if (!gate.allowed) { await interaction.reply({content:gate.reason!,flags:MessageFlags.Ephemeral}); return; }
    const result=await db.delete(signupsTable).where(and(eq(signupsTable.tournamentId,tournamentId),eq(signupsTable.managerId,member.id))).returning();
    if (!result.length) { await interaction.reply({content:"You weren't signed up.",flags:MessageFlags.Ephemeral}); return; }
    await interaction.reply({content:"✅ Withdrawn from the tournament.",flags:MessageFlags.Ephemeral});
    await setManagerTag(member,false);
    await refreshSignupMessage(client,tournamentId); return;
  }
  if (action==="more") {
    const select=new StringSelectMenuBuilder().setCustomId(`signup:menu:${tournamentId}`).setPlaceholder("Choose an action…")
      .addOptions({label:"Add a co-manager",value:"addco",emoji:"👥"},{label:"Change team name",value:"rename",emoji:"✏️"});
    await interaction.reply({content:"What would you like to do?",components:[new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],flags:MessageFlags.Ephemeral});
    return;
  }
}

// ── Select Menu Handler ───────────────────────────────────────────
async function handleSelectMenu(interaction: import("discord.js").StringSelectMenuInteraction) {
  const [ns,kind,idStr]=interaction.customId.split(":");
  if (ns!=="signup"||kind!=="menu") return;
  const tournamentId=Number(idStr);
  if (Number.isNaN(tournamentId)) return;
  const choice=interaction.values[0];

  if (choice==="addco") {
    const modal=new ModalBuilder().setCustomId(`signup:comod:${tournamentId}`).setTitle("Add a co-manager");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("coManagerId").setLabel("Co-manager Discord User ID").setPlaceholder("e.g. 1496566739322802206").setStyle(TextInputStyle.Short).setMinLength(5).setMaxLength(32).setRequired(true)
    ));
    await interaction.showModal(modal); return;
  }
  if (choice==="rename") {
    const modal=new ModalBuilder().setCustomId(`signup:rename:${tournamentId}`).setTitle("Change team name");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("teamName").setLabel("New team name").setPlaceholder("Enter your new team name").setStyle(TextInputStyle.Short).setMinLength(2).setMaxLength(64).setRequired(true)
    ));
    await interaction.showModal(modal); return;
  }
}

// ── Modal Handler ─────────────────────────────────────────────────
async function handleModal(client: Client, interaction: import("discord.js").ModalSubmitInteraction) {
  const [ns,kind,idStr]=interaction.customId.split(":");
  if (ns!=="signup") return;
  const tournamentId=Number(idStr);
  if (Number.isNaN(tournamentId)) return;
  const [t]=await db.select().from(tournamentsTable).where(eq(tournamentsTable.id,tournamentId));
  if (!t) { await interaction.reply({content:"Tournament not found.",flags:MessageFlags.Ephemeral}); return; }
  const member=interaction.member as GuildMember|null;
  if (!member) return;
  const isPremium=memberHasRole(member,t.premiumRoleId);

  if (kind==="modal") {
    const teamName=interaction.fields.getTextInputValue("teamName").trim();
    if (t.closed) { await interaction.reply({content:"Signups are now closed.",flags:MessageFlags.Ephemeral}); return; }
    const gate=canSignup(t.type as TournamentType,new Date(t.startTime),isPremium);
    if (!gate.allowed) { await interaction.reply({content:gate.reason!,flags:MessageFlags.Ephemeral}); return; }
    try {
      await db.insert(signupsTable).values({tournamentId,teamName,managerId:member.id,coManagers:[],isPremium});
    } catch { await interaction.reply({content:"You're already signed up.",flags:MessageFlags.Ephemeral}); return; }
    await interaction.reply({content:`✅ **${teamName}** signed up${isPremium?" 💎":""}. `,flags:MessageFlags.Ephemeral});
    await setManagerTag(member,true);
    await refreshSignupMessage(client,tournamentId); return;
  }
  if (kind==="rename") {
    const teamName=interaction.fields.getTextInputValue("teamName").trim();
    const [existing]=await db.select().from(signupsTable).where(and(eq(signupsTable.tournamentId,tournamentId),eq(signupsTable.managerId,member.id)));
    if (!existing) { await interaction.reply({content:"You're not signed up.",flags:MessageFlags.Ephemeral}); return; }
    await db.update(signupsTable).set({teamName}).where(eq(signupsTable.id,existing.id));
    await interaction.reply({content:`✅ Team name updated to **${teamName}**.`,flags:MessageFlags.Ephemeral});
    await refreshSignupMessage(client,tournamentId); return;
  }
  if (kind==="comod") {
    const coId=interaction.fields.getTextInputValue("coManagerId").trim();
    if (!/^\d{5,32}$/.test(coId)) { await interaction.reply({content:"That doesn't look like a valid Discord user ID.",flags:MessageFlags.Ephemeral}); return; }
    const [existing]=await db.select().from(signupsTable).where(and(eq(signupsTable.tournamentId,tournamentId),eq(signupsTable.managerId,member.id)));
    if (!existing) { await interaction.reply({content:"You need to enter the tournament first.",flags:MessageFlags.Ephemeral}); return; }
    if (existing.coManagers.includes(coId)) { await interaction.reply({content:"Already added.",flags:MessageFlags.Ephemeral}); return; }
    await db.update(signupsTable).set({coManagers:[...existing.coManagers,coId]}).where(eq(signupsTable.id,existing.id));
    await interaction.reply({content:`✅ Added <@${coId}> as a co-manager.`,flags:MessageFlags.Ephemeral});
    await refreshSignupMessage(client,tournamentId); return;
  }
}

// ── Admin HTML ────────────────────────────────────────────────────
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VCT Hub Admin</title>
<style>
:root{--gold:#facc15;--bg:#020617;--surface:#0f172a;--surface2:#1e293b;--text:#f1f5f9;--muted:#94a3b8;--red:#ef4444;}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:100vh;}
header{background:var(--surface);border-bottom:2px solid var(--gold);padding:18px 32px;display:flex;align-items:center;gap:16px;}
header h1{color:var(--gold);font-size:1.5rem;font-weight:800;}
header span{color:var(--muted);font-size:.85rem;margin-left:auto;}
nav{display:flex;border-bottom:1px solid #1e293b;background:var(--surface);}
nav button{background:none;border:none;color:var(--muted);padding:14px 28px;font-size:.95rem;font-weight:600;cursor:pointer;border-bottom:3px solid transparent;transition:all .2s;}
nav button.active{color:var(--gold);border-bottom-color:var(--gold);}nav button:hover{color:var(--text);}
.tab{display:none;padding:28px 32px;}.tab.active{display:block;}
.section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:10px;}
.section-head h2{font-size:1.2rem;color:var(--gold);font-weight:700;}
.btn{display:inline-flex;align-items:center;gap:8px;padding:10px 20px;border-radius:8px;border:none;font-weight:700;font-size:.9rem;cursor:pointer;transition:opacity .15s;}
.btn:hover{opacity:.85;}.btn-gold{background:var(--gold);color:#020617;}.btn-outline{background:transparent;border:2px solid var(--gold);color:var(--gold);}
.btn-red{background:var(--red);color:#fff;}.btn-sm{padding:7px 14px;font-size:.8rem;}
.card{background:var(--surface);border-radius:14px;padding:24px;margin-bottom:16px;}
.card-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px;}
.card-title{font-size:1rem;font-weight:700;}
.badge{display:inline-block;padding:3px 10px;border-radius:6px;font-size:.75rem;font-weight:700;}
.badge-open{background:#14532d;color:#4ade80;}.badge-closed{background:#450a0a;color:#f87171;}.badge-type{background:var(--surface2);color:var(--gold);}
.team-row{display:flex;align-items:center;justify-content:space-between;background:var(--surface2);padding:12px 16px;border-radius:8px;margin:6px 0;border-left:3px solid transparent;}
.team-row.premium{border-left-color:var(--gold);}
.team-name{font-weight:700;font-size:.95rem;}.team-meta{color:var(--muted);font-size:.8rem;margin-top:2px;}
.empty{color:var(--muted);font-style:italic;text-align:center;padding:24px;}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:16px;}
.modal-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:100;align-items:center;justify-content:center;}
.modal-bg.open{display:flex;}.modal{background:var(--surface);border-radius:16px;padding:32px;width:min(480px,90vw);}
.modal h3{font-size:1.1rem;font-weight:700;color:var(--gold);margin-bottom:20px;}
.form-group{margin-bottom:16px;}.form-group label{display:block;font-size:.85rem;color:var(--muted);margin-bottom:6px;font-weight:600;}
select,input{width:100%;background:var(--surface2);border:1px solid #334155;border-radius:8px;color:var(--text);padding:10px 14px;font-size:.9rem;}
select:focus,input:focus{outline:2px solid var(--gold);border-color:transparent;}
.modal-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:24px;}
.actions-row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px;}
table{width:100%;border-collapse:collapse;font-size:.9rem;}
th{color:var(--muted);text-align:left;padding:10px 12px;border-bottom:1px solid #1e293b;font-weight:600;font-size:.8rem;text-transform:uppercase;letter-spacing:.05em;}
td{padding:10px 12px;border-bottom:1px solid #0f172a;vertical-align:middle;}
tr:hover td{background:rgba(255,255,255,.015);}
</style>
</head>
<body>
<header><h1>⚡ VCT Hub Admin</h1><span id="status-text">Connecting…</span></header>
<nav>
  <button class="active" onclick="switchTab('signups',this)">📋 Signups</button>
  <button onclick="switchTab('fixtures',this)">🗓️ Fixtures</button>
  <button onclick="switchTab('ko',this)">🏆 Knockout</button>
  <button onclick="switchTab('tournaments',this)">⚙️ Tournaments</button>
</nav>
<div id="tab-signups" class="tab active">
  <div class="section-head"><h2>Team Signups</h2>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
      <select id="type-select" onchange="loadSignups()" style="width:auto;">
        <option value="NH">NH — Normal Hours</option><option value="HR">HR — Height Restrictions</option>
        <option value="CC">CC — Cash Cup</option><option value="LN">LN — Late Night</option>
      </select>
      <button class="btn btn-outline btn-sm" onclick="loadSignups()">↻ Refresh</button>
    </div>
  </div>
  <div id="signups-content"><div class="empty">Loading…</div></div>
</div>
<div id="tab-fixtures" class="tab">
  <div class="section-head"><h2>Group Fixtures</h2>
    <select id="fix-type-select" onchange="loadFixtures()" style="width:auto;">
      <option value="NH">NH</option><option value="HR">HR</option><option value="CC">CC</option><option value="LN">LN</option>
    </select>
  </div>
  <div class="actions-row"><button class="btn btn-gold" onclick="openModal('post-fixtures-modal','pf-type','fix-type-select')">📢 Post Fixtures to Discord</button></div>
  <div id="fixtures-content"><div class="empty">Select a type above.</div></div>
</div>
<div id="tab-ko" class="tab">
  <div class="section-head"><h2>Knockout Bracket</h2>
    <select id="ko-type-select" onchange="loadKO()" style="width:auto;">
      <option value="NH">NH</option><option value="HR">HR</option><option value="CC">CC</option><option value="LN">LN</option>
    </select>
  </div>
  <div class="actions-row"><button class="btn btn-gold" onclick="openModal('post-ko-modal','pk-type','ko-type-select')">📢 Post KO to Discord</button></div>
  <div id="ko-content"><div class="empty">Select a type above.</div></div>
</div>
<div id="tab-tournaments" class="tab">
  <div class="section-head"><h2>All Tournaments</h2>
    <button class="btn btn-outline btn-sm" onclick="loadTournaments()">↻ Refresh</button>
  </div>
  <div id="tournaments-content"><div class="empty">Loading…</div></div>
</div>
<div class="modal-bg" id="post-fixtures-modal">
  <div class="modal"><h3>📢 Post Fixtures to Discord</h3>
    <div class="form-group"><label>Tournament Type</label>
      <select id="pf-type"><option value="NH">NH</option><option value="HR">HR</option><option value="CC">CC</option><option value="LN">LN</option></select>
    </div>
    <div class="form-group"><label>Discord Channel</label><select id="pf-channel"><option>Loading…</option></select></div>
    <di **...**

const port = Number(process.env.PORT ?? 3000);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT: "${process.env.PORT}"`);

app.listen(port, () => logger.info({ port }, "Server listening"));
startBot().catch(err => logger.error({ err }, "Bot failed to start"));