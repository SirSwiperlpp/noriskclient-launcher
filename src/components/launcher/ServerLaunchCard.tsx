"use client";

import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { pingMinecraftServer } from "../../services/world-service";
import type { ServerPingInfo } from "../../types/minecraft";
import { parseMotdToHtml } from "../../utils/motd-utils";
import { useProfileLaunch } from "../../hooks/useProfileLaunch";
import type { LaunchOverrides } from "../../services/process-service";

interface ServerLaunchCardProps {
  serverAddress: string;
  serverName: string;
  profileId: string | null;
  launchOverrides?: LaunchOverrides;
}

/**
 * A clickable server banner: shows the server's icon, name, MOTD and player
 * count (pinged live), and launches the given profile connecting straight to
 * the server on click. Mirrors the old HugoSMP featured-server card.
 */
export function ServerLaunchCard({
  serverAddress,
  serverName,
  profileId,
  launchOverrides,
}: ServerLaunchCardProps) {
  const { t } = useTranslation();
  const [ping, setPing] = useState<ServerPingInfo | null>(null);
  const [pingState, setPingState] = useState<"pending" | "ok" | "error">("pending");

  const { handleQuickPlayLaunch, isLaunching } = useProfileLaunch({
    profileId: profileId ?? "",
  });

  useEffect(() => {
    let mounted = true;
    setPingState("pending");
    pingMinecraftServer(serverAddress)
      .then((info) => {
        if (!mounted) return;
        if (info.error) {
          setPing(null);
          setPingState("error");
        } else {
          setPing(info);
          setPingState("ok");
        }
      })
      .catch(() => {
        if (mounted) {
          setPing(null);
          setPingState("error");
        }
      });
    return () => {
      mounted = false;
    };
  }, [serverAddress]);

  const iconBase64 = ping?.favicon_base64 ?? null;
  const motdInput = ping?.description_json ?? ping?.description ?? "";

  const handleClick = () => {
    if (!profileId) {
      console.error("[ServerLaunchCard] No profile selected for launch");
      return;
    }
    console.log(`[ServerLaunchCard] Launching and connecting to ${serverAddress}`);
    void handleQuickPlayLaunch(undefined, serverAddress, launchOverrides);
  };

  return (
    <button
      onClick={handleClick}
      disabled={!profileId}
      className={cn(
        "group relative w-80 max-w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-colors",
        "bg-white/[0.04] border-white/15 hover:border-white/30 hover:bg-white/[0.08]",
        "disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer",
      )}
      title={`${serverName} — ${serverAddress}`}
    >
      <div className="relative w-14 h-14 flex-shrink-0 rounded-md bg-white/10 ring-1 ring-white/10 overflow-hidden flex items-center justify-center">
        {iconBase64 ? (
          <img
            src={`data:image/png;base64,${iconBase64}`}
            alt=""
            className="w-full h-full object-cover"
            style={{ imageRendering: "pixelated" }}
          />
        ) : (
          <Icon icon="solar:server-bold-duotone" className="w-7 h-7 text-white/40" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="text-sm text-white font-minecraft truncate normal-case">{serverName}</div>

        {pingState === "error" ? (
          <div className="mt-1 text-xs text-rose-300/80 font-minecraft truncate">
            {t("profiles.v3.servers.offline")}
          </div>
        ) : pingState === "pending" ? (
          <div className="mt-1 text-xs text-white/35 font-minecraft flex items-center gap-1.5">
            <Icon icon="svg-spinners:ring-resize" className="w-3 h-3" />
            {t("profiles.v3.servers.pinging")}
          </div>
        ) : motdInput ? (
          <div
            className="mt-1 text-xs font-minecraft whitespace-pre-line line-clamp-2 leading-snug"
            dangerouslySetInnerHTML={{ __html: parseMotdToHtml(motdInput) }}
          />
        ) : null}

        {ping && ping.players_online != null && ping.players_max != null && (
          <div className="mt-1 inline-flex items-center gap-1 text-xs font-minecraft text-white/60">
            <Icon icon="solar:users-group-rounded-bold" className="w-3 h-3" />
            <span className="tabular-nums">
              {ping.players_online}/{ping.players_max}
            </span>
          </div>
        )}
      </div>

      <div className="flex-shrink-0 self-center pr-1">
        <Icon
          icon={isLaunching ? "svg-spinners:ring-resize" : "solar:play-bold"}
          className="w-7 h-7 text-green-400"
        />
      </div>
    </button>
  );
}
