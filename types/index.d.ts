/**
 * MediaGrabber PRO - TypeScript Type Definitions
 * Complete definitions for core data models, streaming structures, and extension state.
 */

export type MediaType = 'video' | 'audio' | 'stream' | 'unknown';
export type ProtocolType = 'HLS' | 'HTTP' | 'AUDIO';

export interface MediaItem {
  id: string;
  url: string;
  filename: string;
  ext: string;
  type: MediaType;
  protocol: ProtocolType;
  label: string;
  size: number;
  sizeFormatted: string;
  quality?: string | null;
  duration?: number | null;
  durationFormatted?: string;
  poster?: string | null;
  isSubChunk?: boolean;
  timestamp: number;
  selectedQualityLabel?: string;
  targetContainer?: string;
  selectedVariantUrl?: string | null;
}

export interface StreamVariant {
  bandwidth: number;
  resolution: string;
  qualityTag: string;
  bitrate: string;
  url: string;
  label: string;
}

export interface HLSKeyInfo {
  method: 'AES-128' | 'NONE';
  uri: string;
  ivHex: string | null;
}

export interface HLSSegment {
  url: string;
  duration: number;
  isInitSegment?: boolean;
  key?: HLSKeyInfo | null;
  seq?: number;
}

export interface HLSPlaylist {
  isMaster: boolean;
  variants?: StreamVariant[];
  totalDuration?: number;
  segmentCount?: number;
  hasEncryption?: boolean;
  segments?: HLSSegment[];
}

export type JobStatus = 'starting' | 'downloading' | 'transmuxing' | 'completed' | 'error' | 'cancelled';

export interface DownloadJob {
  id: string;
  tabId?: number | null;
  media: MediaItem;
  format: 'mp4' | 'm4a' | 'mp3';
  filename: string;
  status: JobStatus;
  percent: number;
  speed: string;
  eta: string;
  text: string;
  startTime: number;
  downloadId?: number;
  error?: string;
}

export interface DownloadProgress {
  status: string;
  percent: number;
  completed?: number;
  total?: number;
  speed?: string;
  eta?: string;
  bytesDownloaded?: number;
  text: string;
}

export interface UserSettings {
  minSizeThreshold: number; // in bytes
  captureHLS: boolean;
  autoBadgeCount: boolean;
  mediaNamingRule: 'title_quality' | 'custom' | 'original' | 'timestamp';
  filenameTemplate: string;
  downloadConcurrency: 2 | 4 | 8;
  defaultSaveAs: boolean;
}

export interface DownloadHistoryRecord {
  filename: string;
  url: string;
  downloadedAt: number;
  downloadId?: number;
}
