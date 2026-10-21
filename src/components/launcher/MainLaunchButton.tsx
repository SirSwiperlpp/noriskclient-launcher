"use client";

import type React from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "@iconify/react";
import { cn } from "../../lib/utils";
import { LaunchState } from "../../store/launch-state-store";
import { Button } from "../ui/buttons/Button";
import { IconButton } from "../ui/buttons/IconButton";
import { RolloutIndicator } from "./RolloutIndicator";

import { useThemeStore } from "../../store/useThemeStore";
import { useVersionSelectionStore } from "../../store/version-selection-store";
import { usePinnedProfilesStore } from "../../store/usePinnedProfilesStore";
import { loaderIconSrc } from "../../lib/loader-icons";
import { useProfileLaunch } from "../../hooks/useProfileLaunch";

interface Version {
  id: string;
  label: string;
  icon?: string;
  isCustom?: boolean;
  profileId?: string;
}

interface MainLaunchButtonProps {
  versions?: Version[];
  defaultVersion?: string;
  className?: string;
  onVersionChange?: (version: string) => void;
  maxWidth?: string;
  selectedVersionLabel?: string;
  mainButtonWidth?: string;
  mainButtonHeight?: string;
}

export function MainLaunchButton({
  defaultVersion,
  className,
  onVersionChange,
  versions,
  maxWidth = "300px",
  selectedVersionLabel,
  mainButtonWidth,
  mainButtonHeight,
}: MainLaunchButtonProps) {
  const { t } = useTranslation();
  // Local state for transient success message styling (can be further integrated if needed)
  const [transientSuccessActive, setTransientSuccessActive] = useState(false);

  const { selectedVersion, setSelectedVersion } = useVersionSelectionStore();
  const { pinnedProfileIds } = usePinnedProfilesStore();
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  // Use the profile launch hook for launch logic
  const { handleLaunch: hookHandleLaunch, isLaunching, statusMessage, launchState } = useProfileLaunch({
    profileId: selectedVersion,
    onLaunchSuccess: () => {
      setTransientSuccessActive(true);
      setTimeout(() => {
        setTransientSuccessActive(false);
      }, 3000);
    },
    onLaunchError: (error: string) => {
      console.error("Launch error:", error);
    },
  });


  // Get profile-specific launch state from hook
  const isButtonLaunching = isLaunching;
  const buttonStatusMessage = statusMessage;

  useEffect(() => {
    const currentStoreVersion = selectedVersion;
    const storeVersionIsValidInProps = versions?.some(
      (v) => v.id === currentStoreVersion
    );

    if (defaultVersion) {
      if (
        !storeVersionIsValidInProps ||
        currentStoreVersion !== defaultVersion
      ) {
        const defaultVersionPropIsValidInProps = versions?.some(
          (v) => v.id === defaultVersion
        );
        if (defaultVersionPropIsValidInProps) {
          setSelectedVersion(defaultVersion);
        } else if (versions && versions.length > 0) {
          setSelectedVersion(versions[0].id);
        } else {
          setSelectedVersion("");
        }
      }
    } else {
      if (!storeVersionIsValidInProps) {
        if (versions && versions.length > 0) {
          setSelectedVersion(versions[0].id);
        } else {
          setSelectedVersion("");
        }
      }
    }
  }, [defaultVersion, versions, selectedVersion, setSelectedVersion]);




  const handleLaunch = async () => {
    if (!selectedVersion) return;
    await hookHandleLaunch();
  };

  const handleVersionChange = (version: string) => {
    if (isButtonLaunching) return;
    if (onVersionChange) {
      onVersionChange(version);
    }
  };

  const handleToggleDropdown = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isButtonLaunching) return;
    setIsDropdownOpen((open) => !open);
  };

  const handleSelectPinned = (versionId: string) => {
    setSelectedVersion(versionId);
    if (onVersionChange) {
      onVersionChange(versionId);
    }
    setIsDropdownOpen(false);
  };

  // Pinned profiles (from the local pin store), in pin order, that still exist.
  const pinnedVersions = pinnedProfileIds
    .map((id) => versions?.find((v) => v.id === id))
    .filter((v): v is Version => Boolean(v));

  const getMainButtonIcon = () => {
    if (isButtonLaunching) {
      return <Icon icon="solar:stop-bold" width="24" height="24" />;
    }
    return <Icon icon="solar:play-bold" width="24" height="24" />;
  };

  const renderLaunchButtonContent = () => {
    const actionText = isButtonLaunching ? "Stop" : "Launch";

    let statusSubText: string | null | undefined = null;
    let statusColorClass = "opacity-85";

    if (transientSuccessActive && buttonStatusMessage === t('launch.starting')) {
      statusSubText = buttonStatusMessage;
      statusColorClass = "text-green-400";
    } else if (isButtonLaunching) {
      statusSubText = buttonStatusMessage || "Launching...";
      statusColorClass =
        buttonStatusMessage
          ? "opacity-90 text-white"
          : "opacity-75";
    } else if (buttonStatusMessage && launchState === LaunchState.ERROR) {
      statusSubText = buttonStatusMessage;
      statusColorClass = "text-red-400";
    } else if (buttonStatusMessage) {
      statusSubText = buttonStatusMessage;
      statusColorClass = "opacity-85";
    }

    const displaySubText = statusSubText || selectedVersionLabel;
    return (
      <div className="w-full flex flex-col items-center justify-center leading-none -translate-y-[5px]">
        <span className="text-3xl text-center">{actionText}</span>
        {displaySubText && (
          <span
            className={cn(
              "text-xs font-minecraft tracking-normal text-center normal-case whitespace-nowrap overflow-hidden text-ellipsis",
              isButtonLaunching ? "max-w-64" : "",
              statusColorClass
            )}
            style={isButtonLaunching ? { maxWidth: "16rem" } : undefined}
            title={
              typeof displaySubText === "string" ? displaySubText : undefined
            }
          >
            {displaySubText}
          </span>
        )}
      </div>
    );
  };

  const getButtonVariant = () => {
    if (isButtonLaunching) {
      return "destructive";
    }
    return "3d";
  };

  return (
    <div
      className={cn("relative flex flex-col justify-center", className)}
      style={{ maxWidth }}
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center relative">
          <Button
            onClick={handleLaunch}
            disabled={
              !selectedVersion ||
              (versions && versions.length === 0 && !selectedVersion)
            }
            size="xl"
            icon={undefined}
            variant={getButtonVariant()}
            className={cn("flex-1 rounded-r-none", mainButtonWidth)}
            heightClassName={mainButtonHeight}
          >
            {renderLaunchButtonContent()}
          </Button>

          <IconButton
            onClick={handleToggleDropdown}
            disabled={isButtonLaunching || !versions || versions.length === 0}
            size="xl"
            className={cn("rounded-l-none border-l-0", mainButtonHeight)}
            icon={
              <Icon icon="solar:alt-arrow-down-bold" width="24" height="24" />
            }
            variant={
              getButtonVariant() === "destructive" ? "destructive" : "3d"
            }
            aria-label={t('launcher.select_version')}
            aria-expanded={isDropdownOpen}
          />

          <div className="absolute -top-2 -left-2 w-7 h-7 z-10 pointer-events-auto">
            <RolloutIndicator />
          </div>
        </div>
      </div>

      {isDropdownOpen && (
        <>
          {/* Click-outside backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsDropdownOpen(false)}
          />
          <div className="absolute bottom-full right-0 mb-2 z-50 w-64 max-h-80 overflow-y-auto rounded-lg border border-white/15 bg-black/90 backdrop-blur-md shadow-xl p-1">
            <div className="px-3 py-2 text-xs uppercase tracking-wide text-white/50 font-minecraft">
              {t('launcher.pinned_profiles')}
            </div>
            {pinnedVersions.length === 0 ? (
              <div className="px-3 py-3 text-sm text-white/60">
                {t('launcher.pinned_empty')}
              </div>
            ) : (
              pinnedVersions.map((v) => {
                const isSelected = v.id === selectedVersion;
                return (
                  <button
                    key={v.id}
                    onClick={() => handleSelectPinned(v.id)}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 py-2 rounded-md text-left transition-colors",
                      isSelected
                        ? "bg-white/15 text-white"
                        : "text-white/80 hover:bg-white/10"
                    )}
                  >
                    <img
                      src={loaderIconSrc(v.icon)}
                      alt=""
                      className="w-5 h-5 shrink-0"
                      style={{ imageRendering: "pixelated" }}
                    />
                    <span className="flex-1 truncate">{v.label}</span>
                    {isSelected && (
                      <Icon
                        icon="solar:check-circle-bold"
                        width="18"
                        height="18"
                        className="shrink-0"
                      />
                    )}
                  </button>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}
