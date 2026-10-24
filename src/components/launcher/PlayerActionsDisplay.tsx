"use client";

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/buttons/Button';
import { useProfileWizardStore } from '../../store/profile-wizard-store';
import { MainLaunchButton } from './MainLaunchButton';
import { ServerLaunchCard } from './ServerLaunchCard';
import { PlayerRig } from './PlayerRig';
import { useThemeStore } from '../../store/useThemeStore';
import type { PromoOutlineConfig } from '@noriskclient/nrc-skin-renderer/postfx';

// Realityrift ad: clickable text above the launch button that reveals a server
// banner (MOTD + icon) which launches and connects to the Realityrift server.
const REALITYRIFT_SERVER = 'realityrift.de';
const REALITYRIFT_NAME = 'Realityrift.de';

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
  /** Whether profiles are still being loaded. Distinguishes "loading" from
   *  "loaded but empty" so the launch button isn't hidden forever at 0 profiles. */
  isLoading?: boolean;
}

export function PlayerActionsDisplay({
  playerName,
  launchButtonDefaultVersion,
  onLaunchVersionChange,
  launchButtonVersions,
  className,
  displayMode = 'playerName',
  outline,
  isLoading = false,
}: PlayerActionsDisplayProps) {
  const { t } = useTranslation();
  const accentColor = useThemeStore((state) => state.accentColor);
  const hideRealityriftAd = useThemeStore((state) => state.hideRealityriftAd);
  const { openModal: openWizard } = useProfileWizardStore();

  const [showServerCard, setShowServerCard] = useState(false);

  const hasProfiles = launchButtonVersions.length > 0;

  const selectedProfileId =
    launchButtonVersions.find((v) => v.id === launchButtonDefaultVersion)?.profileId ?? null;

  const dropShadowX = '2px';
  const dropShadowY = '4px';
  const dropShadowBlur = '6px';
  const commonDropShadowStyle = `drop-shadow(${dropShadowX} ${dropShadowY} ${dropShadowBlur} ${accentColor.value})`;

  const selectedVersionLabel = launchButtonVersions.find(v => v.id === launchButtonDefaultVersion)?.label;

  // The banner is only ever shown when the ad is enabled.
  const cardVisible = showServerCard && !hideRealityriftAd;

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

        {!isLoading && (
          hasProfiles ? (
            <>
              {/* Realityrift ad toggle: text above the launch button */}
              {!hideRealityriftAd && (
                <div
                  className={`absolute left-0 right-0 flex justify-center px-4 z-30 transition-all duration-300 ${cardVisible ? 'bottom-32' : 'bottom-24'}`}
                >
                  <button
                    onClick={() => setShowServerCard((v) => !v)}
                    className="font-smallcaps text-base text-white/70 hover:text-white transition-all duration-200 cursor-pointer bg-transparent border-none p-0 whitespace-nowrap text-shadow"
                    title={cardVisible ? t('realityrift.back') : REALITYRIFT_NAME}
                  >
                    {cardVisible ? t('realityrift.back') : REALITYRIFT_NAME}
                  </button>
                </div>
              )}

              <div className={`absolute left-0 right-0 flex justify-center px-4 bottom-2`}>
                {cardVisible ? (
                  <ServerLaunchCard
                    serverAddress={REALITYRIFT_SERVER}
                    serverName={REALITYRIFT_NAME}
                    profileId={selectedProfileId}
                  />
                ) : (
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
                )}
              </div>
            </>
          ) : (
            // Loaded, but no profiles exist (standard profiles are no longer
            // auto-pulled). Offer to create one instead of hiding the button.
            <div className="absolute left-0 right-0 flex justify-center px-4 bottom-2">
              <div className="max-w-xs sm:max-w-sm">
                <Button
                  onClick={() => openWizard(null)}
                  size="xl"
                  variant="3d"
                  className="w-80"
                  heightClassName="h-20"
                  icon={<Icon icon="solar:widget-add-bold" width="24" height="24" />}
                >
                  {t('profiles.create')}
                </Button>
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}
