/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Prepare the build by bundling workspace dependencies
 * This script is run before electron-builder packages the app
 */

const log = (message) => {
  console.log(`[Prepare Build] ${message}`);
};

const error = (message) => {
  console.error(`[Prepare Build Error] ${message}`);
};

async function prepareBuild() {
  try {
    log('Starting build preparation...');

    const guiDir = path.join(__dirname, '..');
    const coreDir = path.join(__dirname, '../../core');
    const targetNodeModules = path.join(guiDir, 'node_modules', '@google');

    // Ensure core package is built
    log('Building core package...');
    try {
      execSync('npm run build', {
        cwd: coreDir,
        stdio: 'inherit'
      });
      log('✅ Core package built successfully');
    } catch (err) {
      error('Failed to build core package');
      throw err;
    }

    // Create @google directory in node_modules if it doesn't exist
    if (!fs.existsSync(targetNodeModules)) {
      fs.mkdirSync(targetNodeModules, { recursive: true });
      log('Created @google directory in node_modules');
    }

    // Copy built core package to node_modules
    const corePackageTarget = path.join(targetNodeModules, 'gemini-cli-core');

    log('Copying core package to node_modules...');

    // Remove existing if present
    if (fs.existsSync(corePackageTarget)) {
      fs.rmSync(corePackageTarget, { recursive: true, force: true });
    }

    // Copy core package (exclude source files and dev-only directories)
    // Note: dotnet-processor and temp are excluded here because:
    // - dotnet-processor is copied separately by copy-python.js afterPack hook
    // - temp directory contains runtime data not needed in package
    copyDirectory(coreDir, corePackageTarget, [
      'node_modules',
      'src',
      '.git',
      'coverage',
      'test',
      'dotnet-processor',
      'temp',
      'data',
      '.backups'
    ]);

    log('✅ Core package copied to node_modules');

    // Install core package dependencies
    log('Installing core package dependencies...');
    try {
      execSync('npm install --production --no-save', {
        cwd: corePackageTarget,
        stdio: 'inherit'
      });
      log('✅ Core dependencies installed');
    } catch (err) {
      error('Failed to install core dependencies');
      throw err;
    }

    // Install and prepare extensions
    try {
      await prepareExtensions();
    } catch (err) {
      error(`Failed to prepare extensions: ${err.message}`);
      // Don't fail the build if extensions fail - they are optional
    }

    log('✅ Build preparation completed successfully');
  } catch (err) {
    error(`Build preparation failed: ${err.message}`);
    process.exit(1);
  }
}

function copyDirectory(src, dest, excludeDirs = [], isRoot = true) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      // Only apply excludeDirs at root level
      if (!isRoot || !excludeDirs.includes(entry.name)) {
        copyDirectory(srcPath, destPath, excludeDirs, false);
      }
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Prepare extensions: detect, install dependencies, and copy to node_modules
 */
async function prepareExtensions() {
  log('Checking for extensions...');

  const extensionsDir = path.join(__dirname, '../../extensions');

  // Check if extensions directory exists
  if (!fs.existsSync(extensionsDir)) {
    log('No extensions directory found, skipping extensions preparation');
    return;
  }

  const targetExtensionsDir = path.join(__dirname, '..', 'node_modules', '@google', 'extensions');

  // Get all extension directories
  const extensionDirs = fs.readdirSync(extensionsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);

  if (extensionDirs.length === 0) {
    log('No extensions found in extensions directory');
    return;
  }

  log(`Found ${extensionDirs.length} extension(s): ${extensionDirs.join(', ')}`);

  // Create target extensions directory
  if (!fs.existsSync(targetExtensionsDir)) {
    fs.mkdirSync(targetExtensionsDir, { recursive: true });
  }

  // Process each extension
  for (const extensionName of extensionDirs) {
    try {
      await prepareExtension(extensionName, extensionsDir, targetExtensionsDir);
    } catch (err) {
      error(`Failed to prepare extension "${extensionName}": ${err.message}`);
      // Continue with other extensions even if one fails
    }
  }

  log('✅ Extensions preparation completed');
}

/**
 * Prepare a single extension: run install script and copy files
 */
async function prepareExtension(extensionName, extensionsDir, targetExtensionsDir) {
  const extensionPath = path.join(extensionsDir, extensionName);
  const extensionJsonPath = path.join(extensionPath, 'gemini-extension.json');

  // Check if it has a gemini-extension.json file
  if (!fs.existsSync(extensionJsonPath)) {
    log(`⚠️  Skipping "${extensionName}" - no gemini-extension.json found`);
    return;
  }

  log(`📦 Preparing extension: ${extensionName}`);

  // Run install-deps.js if it exists
  const installScript = path.join(extensionPath, 'install-deps.js');
  if (fs.existsSync(installScript)) {
    log(`  Running install script for ${extensionName}...`);
    try {
      execSync('node install-deps.js', {
        cwd: extensionPath,
        stdio: 'inherit'
      });
      log(`  ✅ Dependencies installed for ${extensionName}`);
    } catch (err) {
      error(`  ⚠️  Install script failed for ${extensionName}, continuing anyway...`);
    }
  } else {
    log(`  No install script found for ${extensionName}`);
  }

  // Copy extension to target directory
  const targetExtensionPath = path.join(targetExtensionsDir, extensionName);
  log(`  Copying ${extensionName} to node_modules...`);

  // Remove existing if present
  if (fs.existsSync(targetExtensionPath)) {
    fs.rmSync(targetExtensionPath, { recursive: true, force: true });
  }

  // Copy extension directory (exclude certain directories)
  copyDirectory(extensionPath, targetExtensionPath, [
    'node_modules',
    '.git',
    '.github',
    'test',
    'tests',
    '__pycache__',
    '.venv',
    'venv',
    'dist',
    'build',
    '.pytest_cache',
    '.mypy_cache'
  ]);

  log(`  ✅ Extension ${extensionName} copied successfully`);
}

// Run if called directly
if (require.main === module) {
  prepareBuild();
}

module.exports = { prepareBuild };
