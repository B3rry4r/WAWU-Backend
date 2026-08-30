-- CreateEnum
CREATE TYPE "ProductCategory" AS ENUM ('audio_music', 'video_film', 'lighting_studio', 'photography', 'computing', 'art_design', 'gaming_streaming', 'content_creation', 'live_events', 'professional', 'power_accessories');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('draft', 'live', 'hidden');

-- CreateEnum
CREATE TYPE "ShopOrderStatus" AS ENUM ('pending', 'paid', 'failed', 'cancelled', 'refunded');

-- CreateEnum
CREATE TYPE "ShopFulfilment" AS ENUM ('awaiting_dispatch', 'dispatched', 'delivered');

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "brand" TEXT,
    "description" TEXT NOT NULL,
    "category" "ProductCategory" NOT NULL,
    "subcategory" TEXT NOT NULL,
    "priceNaira" INTEGER NOT NULL,
    "compareAtNaira" INTEGER,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "images" TEXT[],
    "wawuVerified" BOOLEAN NOT NULL DEFAULT false,
    "wawuPick" BOOLEAN NOT NULL DEFAULT false,
    "ratingAvg" DECIMAL(2,1),
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "status" "ProductStatus" NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CartItem" (
    "id" TEXT NOT NULL,
    "userWawuId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CartItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopOrder" (
    "id" TEXT NOT NULL,
    "buyerWawuId" TEXT NOT NULL,
    "status" "ShopOrderStatus" NOT NULL DEFAULT 'pending',
    "subtotalNaira" INTEGER NOT NULL,
    "totalNaira" INTEGER NOT NULL,
    "deliveryName" TEXT NOT NULL,
    "deliveryPhone" TEXT NOT NULL,
    "deliveryAddress" TEXT NOT NULL,
    "deliveryCity" TEXT NOT NULL,
    "deliveryState" TEXT NOT NULL,
    "deliveryNote" TEXT,
    "fulfilment" "ShopFulfilment" NOT NULL DEFAULT 'awaiting_dispatch',
    "dispatchedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "trackingNote" TEXT,
    "flutterwaveTxRef" TEXT NOT NULL,
    "flutterwaveTxId" TEXT,
    "refundError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "ShopOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopOrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "nameSnapshot" TEXT NOT NULL,
    "priceNairaSnapshot" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "ShopOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Product_slug_key" ON "Product"("slug");

-- CreateIndex
CREATE INDEX "Product_status_category_idx" ON "Product"("status", "category");

-- CreateIndex
CREATE INDEX "Product_status_wawuPick_idx" ON "Product"("status", "wawuPick");

-- CreateIndex
CREATE INDEX "CartItem_userWawuId_idx" ON "CartItem"("userWawuId");

-- CreateIndex
CREATE UNIQUE INDEX "CartItem_userWawuId_productId_key" ON "CartItem"("userWawuId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopOrder_flutterwaveTxRef_key" ON "ShopOrder"("flutterwaveTxRef");

-- CreateIndex
CREATE INDEX "ShopOrder_buyerWawuId_status_idx" ON "ShopOrder"("buyerWawuId", "status");

-- CreateIndex
CREATE INDEX "ShopOrder_status_fulfilment_idx" ON "ShopOrder"("status", "fulfilment");

-- CreateIndex
CREATE INDEX "ShopOrderItem_orderId_idx" ON "ShopOrderItem"("orderId");

-- AddForeignKey
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopOrderItem" ADD CONSTRAINT "ShopOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ShopOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopOrderItem" ADD CONSTRAINT "ShopOrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
