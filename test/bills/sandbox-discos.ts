/**
 * `GET /billing/discos` exactly as the sandbox answered it on 2 Oct 2026 (mobile repo
 * `docs/fintava/sandbox/16-bills-discos.md`, the re-run with the merchant active): 22 codes, limits as strings in naira,
 * `is_available` "Yes" or "No". Ids are shortened; nothing else is changed.
 */
export interface SandboxDisco {
  id: string;
  code: string;
  description: string;
  minimum_value: string;
  maximum_value: string;
  is_available: 'Yes' | 'No';
}

export const SANDBOX_DISCO_ROWS: SandboxDisco[] = [
  {
    id: 'd1',
    code: 'AEDC',
    description: 'AEDC Prepaid',
    minimum_value: '500',
    maximum_value: '10000000',
    is_available: 'Yes',
  },
  {
    id: 'd2',
    code: 'Ikeja_Electric_Bill_Payment',
    description: 'Ikeja Electric Bill Payment',
    minimum_value: '500',
    maximum_value: '500000',
    is_available: 'Yes',
  },
  {
    id: 'd3',
    code: 'Ikeja_Token_Purchase',
    description: 'Ikeja Token Purchase',
    minimum_value: '500',
    maximum_value: '500000',
    is_available: 'Yes',
  },
  {
    id: 'd4',
    code: 'Eko_Prepaid',
    description: 'Eko Prepaid',
    minimum_value: '1000',
    maximum_value: '500000',
    is_available: 'Yes',
  },
  {
    id: 'd5',
    code: 'Eko_Postpaid',
    description: 'Eko_Postpaid',
    minimum_value: '900',
    maximum_value: '300000000',
    is_available: 'Yes',
  },
  {
    id: 'd6',
    code: 'Ibadan_Disco_Prepaid',
    description: 'Ibadan Disco Prepaid',
    minimum_value: '0',
    maximum_value: '1000000',
    is_available: 'Yes',
  },
  {
    id: 'd7',
    code: 'Kano_Electricity_Disco',
    description: 'Kano Electricity DISCO',
    minimum_value: '500',
    maximum_value: '1000000',
    is_available: 'Yes',
  },
  {
    id: 'd8',
    code: 'Kaduna_Electricity_Disco',
    description: 'Kaduna Electricity DISCO',
    minimum_value: '500',
    maximum_value: '100000',
    is_available: 'Yes',
  },
  {
    id: 'd9',
    code: 'Jos_Disco',
    description: 'Jos Electricity Distribution',
    minimum_value: '1000',
    maximum_value: '5000000',
    is_available: 'Yes',
  },
  {
    id: 'd10',
    code: 'BEDC',
    description: 'BEDC',
    minimum_value: '500',
    maximum_value: '500000',
    is_available: 'Yes',
  },
  {
    id: 'd11',
    code: 'PhED_Electricity',
    description: 'Port Harcourt Electricity Distribution Prepaid',
    minimum_value: '500',
    maximum_value: '100000',
    is_available: 'Yes',
  },
  {
    id: 'd12',
    code: 'PH_Disco',
    description: 'Port Harcourt Electricity Distribution Postpaid',
    minimum_value: '900',
    maximum_value: '100000',
    is_available: 'Yes',
  },
  {
    id: 'd13',
    code: 'Kaduna_Electricity_Disco_Postpaid',
    description: 'Kaduna Electricity Disco Postpaid',
    minimum_value: '900',
    maximum_value: '5000000',
    is_available: 'No',
  },
  {
    id: 'd14',
    code: 'AEDC_Postpaid',
    description: 'AEDC Postpaid',
    minimum_value: '900',
    maximum_value: '21000000',
    is_available: 'Yes',
  },
  {
    id: 'd15',
    code: 'Jos_Disco_Postpaid',
    description: 'Jos Electricity Postpaid',
    minimum_value: '1000',
    maximum_value: '10000000',
    is_available: 'Yes',
  },
  {
    id: 'd16',
    code: 'Enugu_Electricity_Distribution_Prepaid',
    description: 'Enugu Electricity Distribution Prepaid',
    minimum_value: '500',
    maximum_value: '100000',
    is_available: 'Yes',
  },
  {
    id: 'd17',
    code: 'Kano_Electricity_Disco_Postpaid',
    description: 'Kano Electricity Disco Postpaid',
    minimum_value: '500',
    maximum_value: '10000000',
    is_available: 'Yes',
  },
  {
    id: 'd18',
    code: 'Ibadan_Disco_Postpaid',
    description: 'Ibadan Disco Postpaid',
    minimum_value: '0',
    maximum_value: '10000000',
    is_available: 'Yes',
  },
  {
    id: 'd19',
    code: 'Enugu_Electricity_Distribution_Postpaid',
    description: 'Enugu Electricity Distribution Postpaid',
    minimum_value: '500',
    maximum_value: '500000',
    is_available: 'Yes',
  },
  {
    id: 'd20',
    code: 'BEDC_Postpaid',
    description: 'BEDC Postpaid',
    minimum_value: '900',
    maximum_value: '1000000',
    is_available: 'Yes',
  },
  {
    id: 'd21',
    code: 'Aba_Power_Prepaid',
    description: 'Aba Power Prepaid',
    minimum_value: '900',
    maximum_value: '1000000',
    is_available: 'Yes',
  },
  {
    id: 'd22',
    code: 'Aba_Power_Postpaid',
    description: 'Aba Power Postpaid',
    minimum_value: '900',
    maximum_value: '1000000',
    is_available: 'Yes',
  },
];

export const SANDBOX_DISCOS = {
  data: SANDBOX_DISCO_ROWS,
  status: 200,
  message: 'Discos records fetched',
};
