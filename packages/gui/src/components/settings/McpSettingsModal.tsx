/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { X, Server, CheckCircle, Circle, Package, RefreshCw } from 'lucide-react';

interface McpServer {
  key: string;
  name: string;
  displayName: string;
  extensionName?: string;
  enabled: boolean;
  description?: string;
  transport: 'stdio' | 'sse' | 'http';
  connected?: boolean;
}

interface McpSettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export const McpSettingsModal: React.FC<McpSettingsModalProps> = ({
  open,
  onClose,
}) => {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  useEffect(() => {
    if (open) {
      loadMcpServers();
    }
  }, [open]);

  const loadMcpServers = async () => {
    setLoading(true);
    setMessage(null);
    try {
      if (!window.electron) {
        throw new Error('Electron API not available');
      }
      const mcpServers = await window.electron.getMcpServers();
      setServers(mcpServers);
    } catch (error) {
      console.error('Failed to load MCP servers:', error);
      setMessage({
        type: 'error',
        text: 'Failed to load MCP servers',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = (serverKey: string) => {
    setServers((prev) =>
      prev.map((server) =>
        server.key === serverKey
          ? { ...server, enabled: !server.enabled }
          : server,
      ),
    );
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      if (!window.electron) {
        throw new Error('Electron API not available');
      }
      const updates: Record<string, boolean> = {};
      for (const server of servers) {
        updates[server.key] = server.enabled;
      }
      await window.electron.setMcpServersEnabled(updates);
      setMessage({
        type: 'success',
        text: 'MCP server settings saved successfully',
      });
    } catch (error) {
      console.error('Failed to save MCP server settings:', error);
      setMessage({
        type: 'error',
        text: 'Failed to save settings',
      });
    } finally {
      setSaving(false);
    }
  };

  const groupedServers = servers.reduce(
    (acc, server) => {
      if (server.extensionName) {
        if (!acc.extensions[server.extensionName]) {
          acc.extensions[server.extensionName] = [];
        }
        acc.extensions[server.extensionName].push(server);
      } else {
        acc.userDefined.push(server);
      }
      return acc;
    },
    {
      extensions: {} as Record<string, McpServer[]>,
      userDefined: [] as McpServer[],
    },
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background w-full max-w-4xl max-h-[90vh] rounded-lg shadow-lg flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Server className="w-5 h-5" />
            MCP Server Settings
          </h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-accent rounded-md transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {message && (
            <div
              className={`p-4 rounded-md ${
                message.type === 'success'
                  ? 'bg-green-500/10 text-green-600'
                  : 'bg-red-500/10 text-red-600'
              }`}
            >
              {message.text}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {/* User-defined servers */}
              {groupedServers.userDefined.length > 0 && (
                <div>
                  <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                    <Server className="w-4 h-4" />
                    User-Defined Servers
                  </h3>
                  <div className="space-y-2">
                    {groupedServers.userDefined.map((server) => (
                      <ServerItem
                        key={server.key}
                        server={server}
                        onToggle={handleToggle}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Extension servers */}
              {Object.keys(groupedServers.extensions).length > 0 && (
                <div>
                  <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                    <Package className="w-4 h-4" />
                    Extension Servers
                  </h3>
                  <div className="space-y-4">
                    {Object.entries(groupedServers.extensions).map(
                      ([extensionName, extensionServers]) => (
                        <div key={extensionName} className="space-y-2">
                          <h4 className="text-sm font-medium text-muted-foreground">
                            {extensionName}
                          </h4>
                          <div className="space-y-2 pl-4">
                            {extensionServers.map((server) => (
                              <ServerItem
                                key={server.key}
                                server={server}
                                onToggle={handleToggle}
                              />
                            ))}
                          </div>
                        </div>
                      ),
                    )}
                  </div>
                </div>
              )}

              {servers.length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  No MCP servers configured
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-6 border-t border-border">
          <div className="text-sm text-muted-foreground">
            {servers.filter((s) => s.enabled).length} of {servers.length}{' '}
            servers enabled
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2"
            >
              {saving ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save Changes'
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

interface ServerItemProps {
  server: McpServer;
  onToggle: (key: string) => void;
}

const ServerItem: React.FC<ServerItemProps> = ({ server, onToggle }) => {
  const transportBadgeColor =
    server.transport === 'stdio'
      ? 'bg-blue-500/20 text-blue-400'
      : server.transport === 'sse'
        ? 'bg-purple-500/20 text-purple-400'
        : 'bg-green-500/20 text-green-400';

  return (
    <Card className="p-4 hover:bg-accent/50 transition-colors">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h4 className="font-medium truncate">{server.displayName}</h4>
            <span
              className={`px-2 py-0.5 rounded text-xs font-medium ${transportBadgeColor}`}
            >
              {server.transport.toUpperCase()}
            </span>
            {server.connected !== undefined && (
              <span
                className={`flex items-center gap-1 text-xs ${
                  server.connected ? 'text-green-500' : 'text-muted-foreground'
                }`}
              >
                {server.connected ? (
                  <>
                    <CheckCircle className="w-3 h-3" />
                    Connected
                  </>
                ) : (
                  <>
                    <Circle className="w-3 h-3" />
                    Disconnected
                  </>
                )}
              </span>
            )}
          </div>
          {server.description && (
            <p className="text-sm text-muted-foreground line-clamp-2">
              {server.description}
            </p>
          )}
          <p className="text-xs text-muted-foreground mt-1">Key: {server.key}</p>
        </div>

        <button
          onClick={() => onToggle(server.key)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            server.enabled ? 'bg-primary' : 'bg-border'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-background transition-transform ${
              server.enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>
    </Card>
  );
};
