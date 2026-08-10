import { Client, GatewayIntentBits, PermissionsBitField } from 'discord.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
await client.login(process.env.DISCORD_TOKEN!);

for (const partial of client.guilds.cache.values()) {
  const guild = await partial.fetch();
  const me = await guild.members.fetchMe();

  console.log(`\nServer: ${guild.name}`);
  console.log(`Roles:  ${me.roles.cache.map((r) => r.name).join(', ')}`);
  console.log(
    `Server-wide perms: ${
      me.permissions.has(PermissionsBitField.Flags.Administrator)
        ? 'Administrator'
        : me.permissions.toArray().join(', ') || '(none)'
    }`,
  );

  console.log('\nText channels:');
  for (const channel of guild.channels.cache.values()) {
    if (!channel.isTextBased() || channel.isThread()) continue;
    const perms = channel.permissionsFor(me);
    const view = perms?.has(PermissionsBitField.Flags.ViewChannel) ?? false;
    const send = perms?.has(PermissionsBitField.Flags.SendMessages) ?? false;
    console.log(
      `  ${view && send ? 'OK  ' : 'NO  '} #${channel.name}  (${channel.id})  view=${view} send=${send}`,
    );
  }
}

await client.destroy();
