import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { SyncScreen } from "./client/sync-screen";
import { syncNowRpc } from "./shared/rpc";

const SCREEN_ID = "main";

function SyncSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="RefreshCcw" label="Sync" active={currentScreen?.screenId === SCREEN_ID} onPress={() => openScreen({ screenId: SCREEN_ID })} />;
}

export default function contribute(client: PluginClientContext): PluginCleanup {
  const cleanups: PluginCleanup[] = [
    client.addScreen({ id: SCREEN_ID, title: "Sync", Component: SyncScreen }),
    client.addSidebarHeaderItem({ id: "sync", title: "Sync", Component: SyncSidebarItem }),
    client.addSettingsScreen({ id: "sync", title: "Sync", icon: "RefreshCcw", Component: SyncScreen }),
    client.addCommandCenterItem({
      id: "sync-now",
      title: "Sync : synchroniser maintenant",
      icon: "RefreshCcw",
      context: "global",
      async onSelect({ rpc }) {
        await rpc(syncNowRpc, {});
      },
    }),
    client.addCommandCenterItem({
      id: "sync-open",
      title: "Sync : ouvrir",
      icon: "RefreshCcw",
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: SCREEN_ID });
      },
    }),
  ];
  return async () => {
    for (const cleanup of cleanups) await cleanup();
  };
}
