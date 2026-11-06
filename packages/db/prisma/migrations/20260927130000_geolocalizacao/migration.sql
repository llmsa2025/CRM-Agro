-- Mapa (produto §B.1). Coordenada em Contact e Company (colunas anuláveis, sem
-- default: ADD COLUMN é só metadado, não reescreve a tabela), cache global de
-- geocodificação e centroides dos municípios (IBGE). GeoCache e Municipio não
-- têm teamId: são referência pública, sem vínculo com pessoa.
-- Os índices do Contact vêm em migrations próprias (CONCURRENTLY).

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "culturas" TEXT[],
ADD COLUMN     "geoAtualizadoEm" TIMESTAMP(3),
ADD COLUMN     "geoFonte" TEXT,
ADD COLUMN     "geoHash" TEXT,
ADD COLUMN     "geoPrecisao" TEXT,
ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "geoAtualizadoEm" TIMESTAMP(3),
ADD COLUMN     "geoFonte" TEXT,
ADD COLUMN     "geoHash" TEXT,
ADD COLUMN     "geoPrecisao" TEXT,
ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "GeoCache" (
    "chave" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "precisao" TEXT NOT NULL,
    "fonte" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeoCache_pkey" PRIMARY KEY ("chave")
);

-- CreateTable
CREATE TABLE "Municipio" (
    "codigoIbge" INTEGER NOT NULL,
    "nome" TEXT NOT NULL,
    "nomeBusca" TEXT NOT NULL,
    "uf" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "Municipio_pkey" PRIMARY KEY ("codigoIbge")
);

-- CreateIndex
CREATE UNIQUE INDEX "Municipio_uf_nomeBusca_key" ON "Municipio"("uf", "nomeBusca");
