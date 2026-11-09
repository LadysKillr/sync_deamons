import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { DEFAULT_CONFIG_PATHS, FILE_PRESETS, JSON_PRESETS, type FileSet, type GroupMode, type GroupScope, type JsonKey } from "../shared/model";
import {
  groupCreateRpc,
  groupRemoveRpc,
  groupUpdateRpc,
  inviteDecodeRpc,
  inviteRpc,
  nodeUpdateRpc,
  pluginsListRpc,
  statusRpc,
  retryRpc,
  syncNowRpc,
  type GroupView,
  type LocalPlugin,
  type StatusView,
} from "../shared/rpc";
import { MachineStatusPanel } from "./machine-status";
import { AwaitingPanel, ConflictsPanel, LocalPanel, PasswordPanel, UpdatesPanel } from "./panels";
import { Button, Chip, Field, Section, Toggle, ago, useStyles, type Styles } from "./ui";

const MODES: Array<{ id: GroupMode; label: string; hint: string }> = [
  { id: "both", label: "Envoie et reçoit", hint: "bidirectionnel" },
  { id: "receive", label: "Reçoit seulement", hint: "cette machine suit le groupe" },
  { id: "send", label: "Envoie seulement", hint: "cette machine fait référence" },
];

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function useAction(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (work: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await work();
        onDone();
      } catch (caught) {
        setError(message(caught));
      } finally {
        setBusy(false);
      }
    },
    [onDone],
  );
  return { busy, error, run };
}

export function SyncScreen({ theme, layout }: PluginSurfaceProps) {
  const s = useStyles(theme, layout.compact);
  const status = useRpc(statusRpc);
  const listPlugins = useRpc(pluginsListRpc);
  const [view, setView] = useState<StatusView | null>(null);
  const [plugins, setPlugins] = useState<LocalPlugin[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    status({})
      .then((next) => {
        setView(next);
        setLoadError(null);
      })
      .catch((error) => setLoadError(message(error)));
  }, [status]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    listPlugins({})
      .then(({ plugins: list }) => setPlugins(list))
      .catch(() => undefined);
    return () => clearInterval(timer);
    // `status` change d'identité d'un rendu à l'autre : on ne relance pas la boucle pour autant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: s.c.surface0 }} contentContainerStyle={s.screen}>
      <Text style={s.h1}>Synchronisation entre daemons</Text>
      <Text style={s.muted}>
        Plugins et leurs versions, réglages des plugins, agents et config du daemon, fichiers : chiffrés par le mot de passe de chaque groupe,
        dans les deux sens.
      </Text>
      {loadError ? <Text style={s.danger}>{loadError}</Text> : null}
      {view && view.groups.length > 0 ? <SyncAllButton s={s} onDone={refresh} /> : null}
      {view ? (
        <>
          <NodeSection s={s} view={view} onChanged={refresh} />
          {view.groups.map((group, index) => (
            <GroupCard key={group.id} s={s} group={group} index={index} count={view.groups.length} plugins={plugins} interval={view.node.intervalSec} onChanged={refresh} />
          ))}
          <CreateSection s={s} onChanged={refresh} />
        </>
      ) : (
        <Text style={s.muted}>Chargement…</Text>
      )}
    </ScrollView>
  );
}

function SyncAllButton({ s, onDone }: { s: Styles; onDone(): void }) {
  const syncNow = useRpc(syncNowRpc);
  const [doneAt, setDoneAt] = useState<number | null>(null);
  const action = useAction(() => {
    setDoneAt(Date.now());
    onDone();
  });
  return (
    <View style={s.row}>
      <Button s={s} kind="primary" label={action.busy ? "Synchronisation…" : "Synchroniser maintenant"} disabled={action.busy} onPress={() => action.run(() => syncNow({}))} />
      {action.error ? <Text style={s.danger}>{action.error}</Text> : doneAt ? <Text style={s.success}>Fait {ago(doneAt)}</Text> : null}
    </View>
  );
}

function NodeSection({ s, view, onChanged }: { s: Styles; view: StatusView; onChanged(): void }) {
  const update = useRpc(nodeUpdateRpc);
  const { node } = view;
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(node.label);
  const [port, setPort] = useState(String(node.port));
  const [listenHost, setListenHost] = useState(node.listenHost);
  const [advertise, setAdvertise] = useState(node.advertiseUrl ?? "");
  const [interval, setIntervalMin] = useState(String(Math.round(node.intervalSec / 60)));
  const [watch, setWatch] = useState(node.watch);
  const action = useAction(() => {
    setEditing(false);
    onChanged();
  });

  return (
    <Section s={s} title="Cette machine" trailing={<Button s={s} label={editing ? "Annuler" : "Modifier"} onPress={() => setEditing(!editing)} />}>
      <Text style={s.text}>
        {node.label} · <Text style={s.mono}>{node.effectiveUrl}</Text>
      </Text>
      <Text style={node.listening ? s.success : s.danger}>
        {node.listening
          ? `À l'écoute sur ${node.boundHost ?? node.listenHost}:${node.port}${node.listenHost === "auto" ? (node.boundHost === "0.0.0.0" ? " (pas de Tailscale : toutes les interfaces)" : " (Tailscale)") : ""}`
          : `Pas à l'écoute : ${node.listenError ?? "démarrage…"}`}
      </Text>
      <Text style={s.muted}>
        {node.watch
          ? `Changements détectés aussitôt (${node.watching} dossiers surveillés), passage de secours toutes les ${Math.round(node.intervalSec / 60)} min.`
          : `Détection des changements coupée : passage toutes les ${Math.round(node.intervalSec / 60)} min.`}{" "}
        Les autres machines doivent pouvoir joindre l'adresse ci-dessus (Tailscale, réseau local, VPN…).
      </Text>
      {editing ? (
        <View style={{ gap: 10 }}>
          <View style={s.row}>
            <Field s={s} label="Nom de la machine" value={label} onChange={setLabel} />
            <Field s={s} label="Écoute (adresse)" value={listenHost} onChange={setListenHost} hint="auto = Tailscale s'il y en a un ; 0.0.0.0 = toutes les interfaces" />
            <Field s={s} label="Port" value={port} onChange={setPort} />
          </View>
          <View style={s.row}>
            <Field s={s} label="Adresse annoncée (vide = automatique)" value={advertise} onChange={setAdvertise} placeholder="http://100.x.y.z:6780" />
            <Field s={s} label="Passage de secours (min)" value={interval} onChange={setIntervalMin} />
          </View>
          <Toggle s={s} label="Détecter les changements aussitôt" value={watch} onChange={setWatch} />
          {action.error ? <Text style={s.danger}>{action.error}</Text> : null}
          <View style={s.row}>
            <Button
              s={s}
              kind="primary"
              label="Enregistrer"
              disabled={action.busy}
              onPress={() =>
                action.run(() =>
                  update({
                    label: label.trim() || undefined,
                    listenHost: listenHost.trim() || undefined,
                    port: Number(port) || undefined,
                    advertiseUrl: advertise.trim() ? advertise.trim() : null,
                    intervalSec: Number(interval) > 0 ? Math.round(Number(interval) * 60) : undefined,
                    watch,
                  }),
                )
              }
            />
          </View>
        </View>
      ) : null}
    </Section>
  );
}

function GroupCard(props: { s: Styles; group: GroupView; index: number; count: number; plugins: LocalPlugin[]; interval: number; onChanged(): void }) {
  const { s, group, onChanged } = props;
  const update = useRpc(groupUpdateRpc);
  const remove = useRpc(groupRemoveRpc);
  const syncNow = useRpc(syncNowRpc);
  const retry = useRpc(retryRpc);
  const invite = useRpc(inviteRpc);
  const [panel, setPanel] = useState<"none" | "scope" | "peers" | "invite" | "local" | "password">("none");
  const closeAndRefresh = () => (setPanel("none"), onChanged());
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const action = useAction(onChanged);
  const onlineWithin = props.interval * 3 * 1000 + 15_000;

  return (
    <Section
      s={s}
      title={`Groupe « ${group.name} »`}
      trailing={
        <View style={s.row}>
          <Toggle s={s} label="Actif" value={group.enabled} onChange={(enabled) => action.run(() => update({ id: group.id, enabled }))} />
        </View>
      }
    >
      <Text style={s.muted}>
        {MODES.find((mode) => mode.id === group.mode)?.label} · {group.items} éléments · dernier passage {ago(group.lastSyncAt)}
        {group.pending > 0 ? ` · ${group.pending} en attente` : ""}
      </Text>
      {group.revokedBy ? <Text style={s.danger}>Cette machine a été retirée de ce groupe par {group.revokedBy}. Quittez le groupe ou rejoignez-le avec le nouveau mot de passe.</Text> : null}
      {group.lastError && !group.revokedBy ? <Text style={s.warning}>{group.lastError}</Text> : null}
      {group.exclude.length > 0 || group.approval ? (
        <Text style={s.muted}>
          Ici : {group.exclude.length > 0 ? `${group.exclude.length} exclusion(s)` : ""}
          {group.exclude.length > 0 && group.approval ? " · " : ""}
          {group.approval ? "mode approbation" : ""}
        </Text>
      ) : null}

      <View style={{ gap: 4 }}>
        {group.members.map((member) => {
          const online = member.self || (member.lastOkAt !== null && Date.now() - member.lastOkAt < onlineWithin);
          return (
            <Text key={`${member.nodeId}-${member.url}`} style={s.text}>
              <Text style={online ? s.success : member.lastError ? s.danger : s.muted}>● </Text>
              {member.label}
              {member.self ? " (cette machine)" : ""} <Text style={s.mono}>{member.url}</Text>
              {!member.self ? <Text style={s.muted}> · {member.lastError ? member.lastError : `joint ${ago(member.lastOkAt)}`}</Text> : null}
            </Text>
          );
        })}
      </View>

      <MachineStatusPanel s={s} group={group} onChanged={onChanged} />
      <AwaitingPanel s={s} group={group} onChanged={onChanged} />
      <ConflictsPanel s={s} group={group} onChanged={onChanged} />
      <UpdatesPanel s={s} group={group} onChanged={onChanged} />

      {group.problems.length > 0 ? (
        <View style={{ gap: 2 }}>
          <Text style={s.danger}>Problèmes ici :</Text>
          {group.problems.map((problem) => (
            <View key={problem.key} style={s.row}>
              <Text style={s.danger}>
                {problem.key} : {problem.error}
              </Text>
              <Button s={s} label="Réessayer" disabled={action.busy} onPress={() => action.run(() => retry({ id: group.id, key: problem.key }))} />
            </View>
          ))}
          {group.problems.length > 1 ? (
            <Button s={s} label="Tout réessayer" disabled={action.busy} onPress={() => action.run(() => retry({ id: group.id }))} />
          ) : null}
          <Text style={s.muted}>
            Pour un plugin qui échoue toujours sur cette machine (par exemple bloqué par l'antivirus), excluez-le ici : « Cette machine ».
          </Text>
        </View>
      ) : null}

      {group.recent.length > 0 ? (
        <View style={{ gap: 2 }}>
          <Text style={s.muted}>Derniers changements :</Text>
          {group.recent.slice(0, 6).map((item, index) => (
            <Text key={`${item.key}-${item.at}-${index}`} style={s.muted}>
              {ago(item.at)} · {item.action === "published" ? "envoyé" : item.action === "applied" ? "reçu" : "supprimé"} · {item.key}
            </Text>
          ))}
        </View>
      ) : null}

      {group.shadowed.length > 0 ? <Text style={s.muted}>{group.shadowed.length} éléments gérés ici par un groupe placé avant celui-ci.</Text> : null}

      <View style={s.row}>
        <Button s={s} kind="primary" label="Synchroniser" disabled={action.busy} onPress={() => action.run(() => syncNow({ id: group.id }))} />
        <Button s={s} label="Ce qui est synchronisé" onPress={() => setPanel(panel === "scope" ? "none" : "scope")} />
        <Button s={s} label="Cette machine" onPress={() => setPanel(panel === "local" ? "none" : "local")} />
        <Button s={s} label="Machines" onPress={() => setPanel(panel === "peers" ? "none" : "peers")} />
        <Button s={s} label="Mot de passe" onPress={() => setPanel(panel === "password" ? "none" : "password")} />
        <Button
          s={s}
          label="Inviter"
          onPress={() => {
            setPanel(panel === "invite" ? "none" : "invite");
            void invite({ id: group.id }).then(({ code }) => setInviteCode(code));
          }}
        />
        {props.index > 0 ? <Button s={s} label="↑" onPress={() => action.run(() => update({ id: group.id, move: -1 }))} /> : null}
        {props.index < props.count - 1 ? <Button s={s} label="↓" onPress={() => action.run(() => update({ id: group.id, move: 1 }))} /> : null}
        <Button
          s={s}
          kind={confirmLeave ? "danger" : "plain"}
          label={confirmLeave ? "Confirmer : quitter" : "Quitter le groupe"}
          onPress={() => (confirmLeave ? action.run(() => remove({ id: group.id })) : setConfirmLeave(true))}
        />
      </View>
      {action.error ? <Text style={s.danger}>{action.error}</Text> : null}

      {panel === "scope" ? <ScopeEditor s={s} group={group} plugins={props.plugins} onSaved={() => (setPanel("none"), onChanged())} /> : null}
      {panel === "peers" ? <PeersEditor s={s} group={group} onSaved={closeAndRefresh} /> : null}
      {panel === "local" ? <LocalPanel s={s} group={group} onSaved={closeAndRefresh} /> : null}
      {panel === "password" ? <PasswordPanel s={s} group={group} onSaved={onChanged} /> : null}
      {panel === "invite" ? (
        <View style={{ gap: 6 }}>
          <Text style={s.muted}>
            Sur l'autre machine : « Rejoindre », collez ce code, tapez le même mot de passe. Le code ne contient pas le mot de passe.
          </Text>
          <Text selectable style={s.mono}>
            {inviteCode ?? "…"}
          </Text>
        </View>
      ) : null}
    </Section>
  );
}

function parseFileSets(text: string): FileSet[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id = "", ...rest] = line.split("=");
      return { id: id.trim(), path: rest.join("=").trim() };
    });
}

function parseJsonKeys(text: string): JsonKey[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id = "", ...rest] = line.split("=");
      const value = rest.join("=");
      const colon = value.lastIndexOf(":");
      return { id: id.trim(), file: (colon >= 0 ? value.slice(0, colon) : value).trim(), path: (colon >= 0 ? value.slice(colon + 1) : "").trim() };
    });
}

/** Ajoute ou retire une ligne « id = … » d'un texte d'une ligne par élément. */
function toggleLine(text: string, id: string, line: string): string {
  const lines = text.split("\n").map((item) => item.trim()).filter(Boolean);
  const has = lines.some((item) => item.split("=")[0]!.trim() === id);
  return (has ? lines.filter((item) => item.split("=")[0]!.trim() !== id) : [...lines, line]).join("\n");
}
const hasLine = (text: string, id: string) => text.split("\n").some((item) => item.split("=")[0]!.trim() === id);

function ScopeEditor({ s, group, plugins, onSaved }: { s: Styles; group: GroupView; plugins: LocalPlugin[]; onSaved(): void }) {
  const update = useRpc(groupUpdateRpc);
  const [scope, setScope] = useState<GroupScope>(group.scope);
  const [configPaths, setConfigPaths] = useState(group.scope.config.paths.join(", "));
  const [fileSets, setFileSets] = useState(group.scope.files.sets.map((set) => `${set.id} = ${set.path}`).join("\n"));
  const [jsonKeys, setJsonKeys] = useState(group.scope.json.entries.map((entry) => `${entry.id} = ${entry.file} : ${entry.path}`).join("\n"));
  const action = useAction(onSaved);
  const patch = (next: Partial<GroupScope>) => setScope({ ...scope, ...next });
  const ids = new Set(scope.plugins.ids);
  const known = [...new Set([...plugins.filter((plugin) => plugin.syncable).map((plugin) => plugin.id), ...scope.plugins.ids])].sort();

  return (
    <View style={{ gap: 10, borderTopWidth: 1, borderTopColor: s.c.border, paddingTop: 10 }}>
      <Text style={s.muted}>Ce réglage est partagé : il s'applique à toutes les machines du groupe.</Text>
      <Toggle s={s} label="Plugins (installation, version, activé ou non)" value={scope.plugins.enabled} onChange={(enabled) => patch({ plugins: { ...scope.plugins, enabled } })} />
      {scope.plugins.enabled ? (
        <View style={{ gap: 8, paddingLeft: 26 }}>
          <View style={s.row}>
            {(
              [
                ["all", "Tous"],
                ["include", "Seulement ceux-ci"],
                ["exclude", "Tous sauf ceux-ci"],
              ] as const
            ).map(([mode, label]) => (
              <Chip key={mode} s={s} label={label} active={scope.plugins.mode === mode} onPress={() => patch({ plugins: { ...scope.plugins, mode } })} />
            ))}
          </View>
          {scope.plugins.mode !== "all" ? (
            <View style={s.row}>
              {known.map((id) => (
                <Chip
                  key={id}
                  s={s}
                  label={id}
                  active={ids.has(id)}
                  onPress={() => {
                    const next = new Set(ids);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    patch({ plugins: { ...scope.plugins, ids: [...next] } });
                  }}
                />
              ))}
            </View>
          ) : null}
          <Text style={s.muted}>Les plugins installés depuis un dossier local et Sync lui-même restent locaux.</Text>
        </View>
      ) : null}
      <Toggle s={s} label="Réglages des plugins retenus" value={scope.pluginSettings.enabled} onChange={(enabled) => patch({ pluginSettings: { enabled } })} />
      <Toggle s={s} label="Config du daemon (agents, fournisseurs, profils…)" value={scope.config.enabled} onChange={(enabled) => patch({ config: { ...scope.config, enabled } })} />
      {scope.config.enabled ? (
        <View style={{ paddingLeft: 26 }}>
          <Field
            s={s}
            label="Chemins de config.json, séparés par des virgules"
            value={configPaths}
            onChange={setConfigPaths}
            placeholder={DEFAULT_CONFIG_PATHS.join(", ")}
            hint="Jamais : daemon (écoute, mot de passe, relais), plugins, version, app."
          />
        </View>
      ) : null}
      <Toggle s={s} label="Fichiers et dossiers" value={scope.files.enabled} onChange={(enabled) => patch({ files: { ...scope.files, enabled } })} />
      {scope.files.enabled ? (
        <View style={{ paddingLeft: 26 }}>
          <Field
            s={s}
            multiline
            label="Un ensemble par ligne : identifiant = chemin"
            value={fileSets}
            onChange={setFileSets}
            placeholder={"claude-skills = ~/.claude/skills\nclaude-md = ~/.claude/CLAUDE.md"}
            hint="~ = dossier personnel de chaque machine. .git et node_modules sont ignorés ; 4 Mo par fichier au plus."
          />
          <Text style={s.muted}>Préréglages :</Text>
          <View style={s.row}>
            {FILE_PRESETS.map((preset) => (
              <Chip key={preset.id} s={s} label={preset.label} active={hasLine(fileSets, preset.id)} onPress={() => setFileSets(toggleLine(fileSets, preset.id, `${preset.id} = ${preset.path}`))} />
            ))}
          </View>
        </View>
      ) : null}
      <Toggle s={s} label="Clés de fichiers JSON (serveurs MCP, permissions…)" value={scope.json.enabled} onChange={(enabled) => patch({ json: { ...scope.json, enabled } })} />
      {scope.json.enabled ? (
        <View style={{ paddingLeft: 26, gap: 6 }}>
          <Field
            s={s}
            multiline
            label="Une clé par ligne : identifiant = fichier : chemin de la clé"
            value={jsonKeys}
            onChange={setJsonKeys}
            placeholder="claude-mcp = ~/.claude.json : mcpServers"
            hint="Seule la clé est partagée, le reste du fichier reste propre à chaque machine."
          />
          <View style={s.row}>
            {JSON_PRESETS.map((preset) => (
              <Chip key={preset.id} s={s} label={preset.label} active={hasLine(jsonKeys, preset.id)} onPress={() => setJsonKeys(toggleLine(jsonKeys, preset.id, `${preset.id} = ${preset.file} : ${preset.path}`))} />
            ))}
          </View>
        </View>
      ) : null}
      <Toggle s={s} label="Planifications Paseo" value={scope.schedules.enabled} onChange={(enabled) => patch({ schedules: { enabled } })} />
      {scope.schedules.enabled ? (
        <Text style={[s.warning, { paddingLeft: 26 }]}>
          Chaque machine du groupe exécutera ces planifications. Excluez-les (« Cette machine ») là où elles ne doivent pas tourner. Une
          planification dont le dossier de travail manque sur une machine n'y est pas créée.
        </Text>
      ) : null}
      <Toggle s={s} label="Mettre à jour Sync lui-même sur toutes les machines" value={scope.selfUpdate} onChange={(selfUpdate) => patch({ selfUpdate })} />
      <Toggle
        s={s}
        label="Suivre les mises à jour des plugins (une machine vérifie toutes les 6 h et installe, le groupe suit)"
        value={scope.autoUpdatePlugins}
        onChange={(autoUpdatePlugins) => patch({ autoUpdatePlugins })}
      />
      <Toggle s={s} label="Propager les suppressions" value={scope.propagateDeletions} onChange={(propagateDeletions) => patch({ propagateDeletions })} />
      {action.error ? <Text style={s.danger}>{action.error}</Text> : null}
      <View style={s.row}>
        <Button
          s={s}
          kind="primary"
          label="Enregistrer pour tout le groupe"
          disabled={action.busy}
          onPress={() =>
            action.run(() =>
              update({
                id: group.id,
                scope: {
                  ...scope,
                  config: { ...scope.config, paths: configPaths.split(",").map((path) => path.trim()).filter(Boolean) },
                  files: { ...scope.files, sets: parseFileSets(fileSets) },
                  json: { ...scope.json, entries: parseJsonKeys(jsonKeys) },
                },
              }),
            )
          }
        />
      </View>
    </View>
  );
}

function PeersEditor({ s, group, onSaved }: { s: Styles; group: GroupView; onSaved(): void }) {
  const update = useRpc(groupUpdateRpc);
  const [peers, setPeers] = useState(group.peers.join("\n"));
  const [mode, setMode] = useState<GroupMode>(group.mode);
  const action = useAction(onSaved);
  return (
    <View style={{ gap: 10, borderTopWidth: 1, borderTopColor: s.c.border, paddingTop: 10 }}>
      <Field
        s={s}
        multiline
        label="Adresses de départ (une par ligne)"
        value={peers}
        onChange={setPeers}
        placeholder="http://100.x.y.z:6780"
        hint="Une seule suffit : les autres machines du groupe sont découvertes automatiquement."
      />
      <Text style={s.muted}>Rôle de cette machine dans ce groupe :</Text>
      <View style={s.row}>
        {MODES.map((item) => (
          <Chip key={item.id} s={s} label={`${item.label} (${item.hint})`} active={mode === item.id} onPress={() => setMode(item.id)} />
        ))}
      </View>
      {action.error ? <Text style={s.danger}>{action.error}</Text> : null}
      <Button
        s={s}
        kind="primary"
        label="Enregistrer"
        disabled={action.busy}
        onPress={() =>
          action.run(() =>
            update({
              id: group.id,
              mode,
              peers: peers
                .split(/[\n,]/)
                .map((peer) => peer.trim())
                .filter(Boolean),
            }),
          )
        }
      />
    </View>
  );
}

function CreateSection({ s, onChanged }: { s: Styles; onChanged(): void }) {
  const create = useRpc(groupCreateRpc);
  const decode = useRpc(inviteDecodeRpc);
  const [tab, setTab] = useState<"create" | "join">("create");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  const [mode, setMode] = useState<GroupMode>("both");
  const action = useAction(() => {
    setName("");
    setPassword("");
    setInvite("");
    onChanged();
  });

  const submit = () =>
    action.run(async () => {
      let groupName = name.trim();
      let peers: string[] = [];
      if (tab === "join") {
        const text = invite.trim();
        if (text.startsWith("psync1.")) {
          const decoded = await decode({ code: text });
          groupName = groupName || decoded.name;
          peers = decoded.peers;
        } else {
          peers = text
            .split(/[\n,\s]+/)
            .map((peer) => peer.trim())
            .filter(Boolean);
        }
        if (peers.length === 0) throw new Error("Collez un code d'invitation ou l'adresse d'une machine du groupe.");
      }
      if (!groupName) throw new Error("Nom du groupe manquant.");
      await create({ name: groupName, password, peers, mode });
    });

  return (
    <Section s={s} title="Nouveau groupe">
      <View style={s.row}>
        <Chip s={s} label="Créer un groupe" active={tab === "create"} onPress={() => setTab("create")} />
        <Chip s={s} label="Rejoindre un groupe" active={tab === "join"} onPress={() => setTab("join")} />
      </View>
      <Text style={s.muted}>
        {tab === "create"
          ? "Par exemple « travail », « perso » ou « jeux » : chaque groupe a son mot de passe et choisit ce qu'il synchronise."
          : "La machine adopte l'état du groupe ; ce qu'elle a en plus rejoint le groupe."}
      </Text>
      {tab === "join" ? (
        <Field s={s} label="Code d'invitation ou adresse d'une machine du groupe" value={invite} onChange={setInvite} placeholder="psync1.… ou http://100.x.y.z:6780" />
      ) : null}
      <View style={s.row}>
        <Field s={s} label={tab === "join" ? "Nom du groupe (vide = celui du code)" : "Nom du groupe"} value={name} onChange={setName} placeholder="travail" />
        <Field s={s} label="Mot de passe du groupe" value={password} onChange={setPassword} secure hint="Le même sur chaque machine. 8 caractères au moins." />
      </View>
      <View style={s.row}>
        {MODES.map((item) => (
          <Chip key={item.id} s={s} label={item.label} active={mode === item.id} onPress={() => setMode(item.id)} />
        ))}
      </View>
      {action.error ? <Text style={s.danger}>{action.error}</Text> : null}
      <View style={s.row}>
        <Button s={s} kind="primary" label={tab === "create" ? "Créer" : "Rejoindre"} disabled={action.busy || password.length < 8} onPress={submit} />
        {action.busy ? <Text style={s.muted}>Dérivation de la clé…</Text> : null}
      </View>
    </Section>
  );
}
