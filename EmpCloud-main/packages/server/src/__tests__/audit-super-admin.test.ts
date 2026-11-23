// =============================================================================
// Test: Audit Service — Super Admin (org_id=0) Handling
// Verifies that org_id=0 (super_admin sentinel) is converted to NULL
// to avoid FK constraint violation in audit_logs table.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockInsert = vi.fn().mockResolvedValue(undefined);
const mockAuditLogsChain = vi.fn(() => ({
  insert: mockInsert,
}));
const mockGetDB = vi.fn(() => mockAuditLogsChain);

vi.mock("../db/connection.js", () => ({
  getDB: mockGetDB,
}));

describe("AuditService — Super Admin Handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("converts organization_id=0 (super_admin) to NULL", async () => {
    const { logAudit } = await import("../services/audit/audit.service.js");

    await logAudit({
      organizationId: 0, // Super admin sentinel
      userId: 1,
      action: "login",
      ipAddress: "127.0.0.1",
      userAgent: "Mozilla/5.0",
    });

    // Verify that logAudit called getDB()("audit_logs").insert() with organization_id=NULL
    expect(mockGetDB).toHaveBeenCalled();
    expect(mockAuditLogsChain).toHaveBeenCalledWith("audit_logs");
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: null, // Should be NULL, not 0
        user_id: 1,
        action: "login",
        ip_address: "127.0.0.1",
        user_agent: "Mozilla/5.0",
      })
    );
  });

  it("preserves organization_id for regular organizations", async () => {
    const { logAudit } = await import("../services/audit/audit.service.js");

    await logAudit({
      organizationId: 5, // Regular organization
      userId: 42,
      action: "employee_created",
      details: { employee_id: 100 },
    });

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: 5, // Should be preserved
        user_id: 42,
        action: "employee_created",
        details: JSON.stringify({ employee_id: 100 }),
      })
    );
  });

  it("converts undefined organization_id to NULL", async () => {
    const { logAudit } = await import("../services/audit/audit.service.js");

    await logAudit({
      userId: 1,
      action: "login",
    });

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: null, // undefined → null
        user_id: 1,
        action: "login",
      })
    );
  });

  it("includes all optional fields when provided", async () => {
    const { logAudit } = await import("../services/audit/audit.service.js");

    const details = { event_type: "super_admin_access", timestamp: "2024-01-01" };
    await logAudit({
      organizationId: 0,
      userId: 1,
      action: "ADMIN_LOGIN",
      resourceType: "user",
      resourceId: "1",
      details,
      ipAddress: "192.168.1.1",
      userAgent: "Chrome/120",
    });

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: null, // 0 → null
        user_id: 1,
        action: "ADMIN_LOGIN",
        resource_type: "user",
        resource_id: "1",
        details: JSON.stringify(details),
        ip_address: "192.168.1.1",
        user_agent: "Chrome/120",
      })
    );
  });
});
