// Copyright (c) 2024-2026 Soumya Debnath <soumyadebnath1661@gmail.com>. All rights reserved.
// Business Source License 1.1 (BSL 1.1) — Commercial License Key Validator

export interface LicenseValidationOptions {
  licenseKey?: string;
  allowEval?: boolean;
}

export class LicenseValidator {
  private static readonly AUTHOR = "Soumya Debnath";
  private static readonly CONTACT = "soumyadebnath1661@gmail.com";

  /**
   * Read an environment variable without requiring @types/node.
   * `tsc --noEmit` previously reported four TS2580 errors here because the file
   * references the Node `process` global while tsconfig only includes DOM libs.
   */
  private static env(name: string): string | undefined {
    const proc = (globalThis as any).process;
    const value = proc && proc.env ? proc.env[name] : undefined;
    return typeof value === "string" ? value : undefined;
  }

  private static hasProcess(): boolean {
    return typeof (globalThis as any).process !== "undefined";
  }

  public static validate(options?: LicenseValidationOptions): boolean {
    const key = options?.licenseKey || LicenseValidator.env("COMMERCIAL_LICENSE_KEY");

    // Development / Localhost evaluation bypass
    const isDev = typeof window !== "undefined"
      ? window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
      : LicenseValidator.hasProcess() && LicenseValidator.env("NODE_ENV") !== "production";

    if (isDev || options?.allowEval) {
      return true;
    }

    if (!key || !key.startsWith("BSL11-")) {
      // NOTE: this warning is printed into the console of every end user of any
      // browser application that embeds SyncForge in production. It therefore
      // must not contain the maintainer's personal contact details. The earlier
      // text disclosed a personal phone number to every visitor.
      //
      // The DMCA § 1201 citation was also removed: § 1201 governs circumvention
      // of technical protection measures, not unlicensed use of a work.
      console.warn(
        'SyncForge: no commercial license key detected. Production use requires a ' +
        'paid license under the Business Source License 1.1. ' +
        'See COMMERCIAL_LICENSE.md or https://github.com/itsoumya-d/syncforge for terms. ' +
        'Set COMMERCIAL_LICENSE_KEY, or pass { allowEval: true } for evaluation use.'
      );
      return false;
    }

    return true;
  }
}
