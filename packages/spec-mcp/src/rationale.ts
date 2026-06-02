/**
 * Provides human-readable rationale for each artifact kind, plus a
 * design-level summary of why the stack of artifacts was structured as it is.
 *
 * Why this file: the original propose tool emitted source code without
 * explaining *why* each annotation, each contract, each layer. A spec without
 * rationale teaches the user nothing and is hard to challenge. With rationale
 * embedded, the reviewer can spot disagreement quickly ("don't use #D quality
 * here, this is transactional").
 *
 * The strings are intentionally short and opinionated. They reflect current
 * ABAP Cloud / RAP best practice as of 2026 — change if SAP guidance evolves.
 */

import type { Artifact } from './spec-model.js';

/** Rationale for one artifact based on its kind + context. */
export function rationaleFor(art: Artifact): {
  bullets: string[];
  annotationsExplained?: Record<string, string>;
} {
  switch (art.kind) {
    case 'cds-interface':
      return {
        bullets: [
          'Camada de exposição estável: interface views (prefixo ZI_) são o ponto de release C1/C2 — outros objetos consomem aqui, garantindo isolamento contra mudanças na fonte.',
          'Sem cálculos nem associações pesadas — apenas seleção e renaming. Mantém serviceQuality #D (dimensional) razoável.',
          'Annotation #NOT_REQUIRED no authorizationCheck é apenas pro modelo de release; a autorização real fica na DCL.',
        ],
        annotationsExplained: {
          '@AbapCatalog.viewEnhancementCategory: [#NONE]':
            'Diz ao runtime que esta view não aceita extensões via "extend view" — útil pra interfaces estáveis. Mude para [#PROJECTION_LIST] se quiser permitir extensões.',
          '@AccessControl.authorizationCheck: #NOT_REQUIRED':
            'A autorização será aplicada na camada de DCL anexada à projection, não na interface — interfaces costumam ser internas.',
          '@Metadata.ignorePropagatedAnnotations: true':
            'Impede que annotations vindas de objetos source poluam esta view — controle declarativo.',
          '@ObjectModel.usageType.serviceQuality: #D':
            'Marca como dado dimensional (referência/master). Use #T para transacional. #A para analítico agregado.',
          '@ObjectModel.usageType.sizeCategory: #S':
            'Estimativa de volume: S (até 1k linhas), M (1k-100k), L (100k-1M), XL (>1M). Influencia otimizador HANA.',
          '@ObjectModel.usageType.dataClass: #MIXED':
            '#MASTER (cadastros), #TRANSACTIONAL (movimentos), #ORGANIZATIONAL (estruturas) ou #MIXED. Afeta classificação de retenção/replicação.',
        },
      };

    case 'cds-composite':
      return {
        bullets: [
          'Camada de cálculos: composite views (ZC_) fazem joins, casts e agregações sobre uma ou mais interfaces.',
          'Não é exposta diretamente para consumo externo — serve a projections.',
          'Mantém o release contract C0/C1 da interface intacto. Mudanças aqui não quebram contrato externo.',
        ],
      };

    case 'cds-projection':
      return {
        bullets: [
          'Camada de consumo: projection views (ZP_) são o "ponto de entrada" para serviços OData e Fiori UIs.',
          '`provider contract transactional_query` declara intenção: leitura analítica. Use `transactional_interface` se houver write-back via RAP behavior.',
          '`define root view entity` é necessário para projections raiz que servem como entidade principal de um service.',
          '@Metadata.allowExtensions: true permite que outros extendam o catálogo de fields exposto — importante em apps Fiori que comportam customizing.',
        ],
        annotationsExplained: {
          'provider contract transactional_query':
            'Read-only otimizado. Outros contratos: transactional_interface (com write), analytical_query (agregações). Errar isso quebra ativação.',
          '@Search.searchable: true':
            'Habilita pesquisa full-text na projeção — ativa Fiori Smart Search/Discovery.',
        },
      };

    case 'cds-extension':
      return {
        bullets: [
          'Estende uma view released SEM modificar a fonte original — útil pra adicionar campos customizados em interfaces SAP.',
          'O contrato de release C0 é obrigatório para que a extensão seja permitida (verificar API state na base).',
          'Pode adicionar campos, associações ou annotations, dependendo de viewEnhancementCategory da base.',
        ],
      };

    case 'access-control':
      return {
        bullets: [
          'DCL (Data Control Language) é a camada de autorização declarativa em ABAP Cloud — substitui a lógica de AUTHORITY-CHECK espalhada.',
          'Avaliada no runtime do CDS — qualquer consumidor (OData, ABAP SQL) respeita automaticamente.',
          '`@MappingRole: true` indica que a DCL não emite SELECT modificado, apenas grants/denies — padrão para perfis abertos.',
          'Para restrição real, use `grant select on V where (Field) = aspect pfcg_auth(...);` referenciando objetos S_TCODE ou criados.',
        ],
      };

    case 'behavior-definition':
      return {
        bullets: [
          'BDEF gerencia o comportamento transacional (CRUD + ações) sobre uma root view via RAP.',
          '`managed implementation`: SAP gera o save/load. Use `unmanaged` quando há lógica legacy sendo encapsulada.',
          '`strict ( 2 )`: nível mais alto de validação de sintaxe RAP — recomendado para código novo.',
          '`persistent table`: aponta para a tabela transparente que armazena o estado. Deve estar listada na CDS root (`as select from <persistent>`).',
          'Adicionar `with draft` + draft table cria suporte a edição em rascunho (essencial para Fiori draft-enabled apps).',
        ],
      };

    case 'behavior-implementation':
      return {
        bullets: [
          'Classe ABAP que implementa o BDEF — herda de cl_abap_behavior_handler e implementa métodos como CREATE, UPDATE, DELETE, e actions definidas no BDEF.',
          'Em modo `managed`, apenas validations/determinations/actions precisam ser codificados aqui — o save é gerado.',
          'Use `FOR BEHAVIOR OF <bdef>` no DEFINITION para vincular ao BDEF correto.',
          'Capitu não gera esta classe automaticamente — o source ABAP é específico demais. Forneça via `source` no artifact, ou crie no Eclipse depois.',
        ],
      };

    case 'service-definition':
      return {
        bullets: [
          'SRVD define quais entidades CDS são expostas e com quais aliases — separação clara entre modelo interno e contrato de serviço.',
          '`expose <projection> as <Alias>`: o Alias é como o cliente OData verá a entidade (controle de evolução).',
          'Você pode expor múltiplas projections no mesmo service para criar APIs compostas.',
        ],
      };

    case 'service-binding':
      return {
        bullets: [
          'SRVB define o protocolo de exposição: OData V2, OData V4 (UI/WebAPI), ou SQL.',
          'É publicado para um sistema (host) e fica disponível em /sap/opu/odata4/...',
          'Capitu não gera SRVB automaticamente — XML estruturado, criar via wizard ADT.',
        ],
      };

    case 'class':
      return {
        bullets: [
          'Classe utilitária ABAP padrão — sem template específico, source deve ser fornecido.',
        ],
      };

    case 'interface':
      return {
        bullets: [
          'Interface ABAP global — define contratos para implementadores. Source fornecido pelo caller.',
        ],
      };

    case 'table':
      return {
        bullets: [
          'Tabela transparente DDIC — armazenamento persistente próprio.',
          'Em ABAP Cloud, considere primeiro reutilizar tabelas released. Custom tables devem ter justificativa clara.',
          '@EndUserText.label não é suficiente — vai precisar definir delivery class, table category e key fields no Eclipse após criação.',
        ],
      };

    case 'domain':
      return {
        bullets: [
          'Domínio DDIC — tipo primitivo com lista de valores fixos (fixed values).',
          'Reuse first: muitos domínios existem released. Custom só quando o conjunto de valores é específico do negócio.',
        ],
      };

    case 'data-element':
      return {
        bullets: [
          'Data element DDIC — semântica de campo (label, help, search help).',
          'Combina um domínio com textos e suporte F4. Reusar released quando possível.',
        ],
      };
  }
}

/** Global rationale for the stack — depends on the mix of kinds present. */
export function globalDesignRationale(artifacts: Artifact[]): string[] {
  const kinds = new Set(artifacts.map((a) => a.kind));
  const bullets: string[] = [];

  const hasInterface = kinds.has('cds-interface');
  const hasComposite = kinds.has('cds-composite');
  const hasProjection = kinds.has('cds-projection');
  const hasBdef = kinds.has('behavior-definition');
  const hasService = kinds.has('service-definition') || kinds.has('service-binding');

  if (hasInterface && hasComposite && hasProjection) {
    bullets.push(
      'Stack de 3 camadas (interface → composite → projection): padrão ABAP Cloud recomendado. Interface estabiliza o contrato de leitura, composite isola cálculos, projection expõe ao consumo. Mudanças de regra ficam contidas na composite sem quebrar API externa.',
    );
  } else if (hasInterface && hasProjection) {
    bullets.push(
      'Stack de 2 camadas (interface → projection): adequado quando não há cálculos pesados. Pode crescer adicionando uma composite no meio se a lógica aumentar.',
    );
  } else if (hasProjection && !hasInterface) {
    bullets.push(
      '⚠️ Projection sem interface: projeção direto sobre tabela ou view released. Funciona, mas perde a camada de estabilização — qualquer mudança na fonte vaza pra consumers. Considere adicionar uma interface intermediária.',
    );
  }

  if (hasBdef) {
    bullets.push(
      'Inclui BDEF: scenário transacional (CRUD via RAP). A projection precisa ter `provider contract transactional_interface` (não transactional_query) para suportar writes.',
    );
  }

  if (hasService) {
    bullets.push(
      'Exposição via service definition + binding: a API gerada vira consumível por Fiori, integração ou App externos. O contract de release da projection determina se isso é consumo interno (C1) ou publicado (C2).',
    );
  }

  if (artifacts.some((a) => a.basedOn?.startsWith('/dmo/'))) {
    bullets.push(
      '⚠️ Base /dmo/* (Demo): /dmo/booking, /dmo/flight, etc. são tabelas demo da SAP — não têm release contract público. OK para aprender e testar em $TMP. Antes de promover para produção, refazer apontando para released APIs (catálogo via SAP API Hub).',
    );
  }

  return bullets;
}
