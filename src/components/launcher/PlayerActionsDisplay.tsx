"use client";

import { cn } from '../../lib/utils';
import { MainLaunchButton } from './MainLaunchButton';
import { PlayerRig } from './PlayerRig';
import { useThemeStore } from '../../store/useThemeStore';
import type { PromoOutlineConfig } from '@noriskclient/nrc-skin-renderer/postfx';

interface PlayerActionsDisplayProps {
  playerName: string | null | undefined;
  launchButtonDefaultVersion: string;
  onLaunchVersionChange: (versionId: string) => void;
  launchButtonVersions: Array<{
    id: string;
    label: string;
    icon?: string;
    isCustom?: boolean;
    profileId: string;
  }>;
  className?: string;
  displayMode?: 'playerName' | 'logo';
  outline?: Partial<PromoOutlineConfig>;
}

export function PlayerActionsDisplay({
  playerName,
  launchButtonDefaultVersion,
  onLaunchVersionChange,
  launchButtonVersions,
  className,
  displayMode = 'playerName',
  outline,
}: PlayerActionsDisplayProps) {
  const accentColor = useThemeStore((state) => state.accentColor);

  const isLoadingProfiles = launchButtonVersions.length === 0;

  const dropShadowX = '2px';
  const dropShadowY = '4px';
  const dropShadowBlur = '6px';
  const commonDropShadowStyle = `drop-shadow(${dropShadowX} ${dropShadowY} ${dropShadowBlur} ${accentColor.value})`;

  const selectedVersionLabel = launchButtonVersions.find(v => v.id === launchButtonDefaultVersion)?.label;

  return (
    <div className={cn("flex flex-col items-center", className)}>

      {displayMode === 'logo' ? (
        <img
          src="norisk_logo_color.png"
          alt="NoRisk Logo"
          className="h-48 sm:h-56 md:h-64 mb-[-80px] sm:mb-[-100px] md:mb-[-120px] relative z-0"
          style={{
            imageRendering: "pixelated",
            filter: commonDropShadowStyle
          }}
        />
      ) : null}

      <div className={cn(
        "relative w-full max-w-[500px] flex flex-col items-center",
        displayMode === 'logo' && "z-10"
      )}>
        <PlayerRig playerName={playerName} outline={outline} />

        {!isLoadingProfiles && (
          <div className={`absolute left-0 right-0 flex justify-center px-4 bottom-2`}>
            <div className="max-w-xs sm:max-w-sm">
              <MainLaunchButton
                defaultVersion={launchButtonDefaultVersion}
                onVersionChange={onLaunchVersionChange}
                versions={launchButtonVersions}
                selectedVersionLabel={selectedVersionLabel}
                mainButtonWidth="w-80"
                maxWidth="400px"
                mainButtonHeight="h-20"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
