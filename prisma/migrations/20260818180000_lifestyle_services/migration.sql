-- Lifestyle Services: WAWUPay (bills), WAWUCare (health), WAWU Legal.

CREATE TYPE "FulfilmentStatus" AS ENUM ('pending', 'paid', 'delivered', 'failed', 'refunded');
CREATE TYPE "LegalPath" AS ENUM ('simple', 'consultation');
CREATE TYPE "ConsultationMedium" AS ENUM ('chat', 'zoom', 'physical');
CREATE TYPE "LegalRequestStatus" AS ENUM (
  'draft', 'awaiting_consultation_payment', 'consultation_scheduled',
  'consultation_done', 'quoted', 'contract_signed',
  'awaiting_service_payment', 'in_progress', 'delivered', 'cancelled'
);

CREATE TABLE "BillPayment" (
  "id"                TEXT NOT NULL,
  "buyerWawuId"       TEXT NOT NULL,
  "category"          TEXT NOT NULL,
  "billerCode"        TEXT NOT NULL,
  "itemCode"          TEXT NOT NULL,
  "billerName"        TEXT NOT NULL,
  "customerRef"       TEXT NOT NULL,
  "amount"            INTEGER NOT NULL,
  "fee"               INTEGER NOT NULL DEFAULT 0,
  "flutterwaveTxRef"  TEXT NOT NULL,
  "flutterwaveTxId"   TEXT,
  "providerReference" TEXT,
  "providerStatus"    TEXT,
  "failureReason"     TEXT,
  "status"            "FulfilmentStatus" NOT NULL DEFAULT 'pending',
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deliveredAt"       TIMESTAMP(3),
  CONSTRAINT "BillPayment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BillPayment_flutterwaveTxRef_key" ON "BillPayment"("flutterwaveTxRef");
CREATE INDEX "BillPayment_buyerWawuId_idx" ON "BillPayment"("buyerWawuId");
CREATE INDEX "BillPayment_status_idx" ON "BillPayment"("status");
CREATE INDEX "BillPayment_status_createdAt_idx" ON "BillPayment"("status", "createdAt");

CREATE TABLE "HealthSubscription" (
  "id"                TEXT NOT NULL,
  "wawuUserId"        TEXT NOT NULL,
  "planCode"          TEXT NOT NULL,
  "planName"          TEXT NOT NULL,
  "price"             INTEGER NOT NULL,
  "phoneNumber"       TEXT NOT NULL,
  "firstName"         TEXT NOT NULL,
  "lastName"          TEXT NOT NULL,
  "gender"            TEXT NOT NULL,
  "dateOfBirth"       TEXT NOT NULL,
  "email"             TEXT,
  "flutterwaveTxRef"  TEXT NOT NULL,
  "flutterwaveTxId"   TEXT,
  "policyNumber"      TEXT,
  "providerReference" TEXT,
  "failureReason"     TEXT,
  "status"            "FulfilmentStatus" NOT NULL DEFAULT 'pending',
  "startsAt"          TIMESTAMP(3),
  "expiresAt"         TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HealthSubscription_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HealthSubscription_flutterwaveTxRef_key" ON "HealthSubscription"("flutterwaveTxRef");
CREATE INDEX "HealthSubscription_wawuUserId_idx" ON "HealthSubscription"("wawuUserId");
CREATE INDEX "HealthSubscription_status_idx" ON "HealthSubscription"("status");

CREATE TABLE "LegalRequest" (
  "id"                 TEXT NOT NULL,
  "wawuUserId"         TEXT NOT NULL,
  "serviceCode"        TEXT NOT NULL,
  "serviceName"        TEXT NOT NULL,
  "category"           TEXT NOT NULL,
  "path"               "LegalPath" NOT NULL,
  "status"             "LegalRequestStatus" NOT NULL DEFAULT 'draft',
  "details"            JSONB,
  "documents"          TEXT[] DEFAULT ARRAY[]::TEXT[],
  "consultationMedium" "ConsultationMedium",
  "consultationFee"    INTEGER,
  "consultationTxRef"  TEXT,
  "consultationPaidAt" TIMESTAMP(3),
  "scheduledFor"       TIMESTAMP(3),
  "consultationNotes"  TEXT,
  "quoteAmount"        INTEGER,
  "quoteNote"          TEXT,
  "contractText"       TEXT,
  "contractSignedAs"   TEXT,
  "contractSignedAt"   TIMESTAMP(3),
  "contractSignedIp"   TEXT,
  "serviceTxRef"       TEXT,
  "servicePaidAt"      TIMESTAMP(3),
  "deliverableUrl"     TEXT,
  "deliveredAt"        TIMESTAMP(3),
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LegalRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LegalRequest_consultationTxRef_key" ON "LegalRequest"("consultationTxRef");
CREATE UNIQUE INDEX "LegalRequest_serviceTxRef_key" ON "LegalRequest"("serviceTxRef");
CREATE INDEX "LegalRequest_wawuUserId_idx" ON "LegalRequest"("wawuUserId");
CREATE INDEX "LegalRequest_status_idx" ON "LegalRequest"("status");
CREATE INDEX "LegalRequest_serviceCode_idx" ON "LegalRequest"("serviceCode");
