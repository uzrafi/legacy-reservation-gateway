import {
  decodeSeatRow,
  fromLegacyAirport,
  fromLegacyAmount,
  fromLegacyDate,
  fromLegacyFlight,
  fromLegacySeat,
  fromLegacyTimestamp,
  LegacyFormatError,
  toLegacyAirport,
  toLegacyAmount,
  toLegacyDate,
  toLegacyFlight,
  toLegacyPassengerName,
  toLegacySeat,
} from '../../src/adapter/codes';

describe('legacy value mapping', () => {
  test('airport codes are 5-wide space padded', () => {
    expect(toLegacyAirport('YYZ')).toBe('YYZ  ');
    expect(fromLegacyAirport('YYZ  ')).toBe('YYZ');
    expect(fromLegacyAirport(' yvr ')).toBe('YVR');
    expect(() => fromLegacyAirport('YY')).toThrow(LegacyFormatError);
  });

  test('flight numbers are zero padded to 4 digits', () => {
    expect(toLegacyFlight('AC105')).toBe('AC0105');
    expect(toLegacyFlight('AC3')).toBe('AC0003');
    expect(toLegacyFlight('AC0105')).toBe('AC0105');
    expect(fromLegacyFlight('AC0003')).toBe('AC3');
    expect(fromLegacyFlight('AC1620')).toBe('AC1620');
    expect(() => toLegacyFlight('105')).toThrow(LegacyFormatError);
  });

  test('dates round-trip through DDMMMYY', () => {
    expect(toLegacyDate('2026-11-14')).toBe('14NOV26');
    expect(toLegacyDate('2027-01-01')).toBe('01JAN27');
    expect(fromLegacyDate('14NOV26')).toBe('2026-11-14');
    expect(fromLegacyDate('29feb28')).toBe('2028-02-29');
    expect(() => fromLegacyDate('14XYZ26')).toThrow(LegacyFormatError);
    expect(() => toLegacyDate('1999-12-31')).toThrow(LegacyFormatError); // outside the two-digit year window
  });

  test('timestamps "DDMMMYY HHMMZ" become ISO-8601', () => {
    expect(fromLegacyTimestamp('14NOV26 1432Z')).toBe('2026-11-14T14:32:00.000Z');
  });

  test('amounts are integer cents in zero-padded strings', () => {
    expect(fromLegacyAmount('0042900')).toBe(42900);
    expect(fromLegacyAmount('0000000')).toBe(0);
    expect(toLegacyAmount(42900)).toBe('0042900');
    expect(() => fromLegacyAmount('429.00')).toThrow(LegacyFormatError);
    expect(() => fromLegacyAmount('')).toThrow(LegacyFormatError);
  });

  test('seats are 3-digit row + letter', () => {
    expect(toLegacySeat('12A')).toBe('012A');
    expect(toLegacySeat('3f')).toBe('003F');
    expect(fromLegacySeat('012A')).toBe('12A');
  });

  test('passenger names become SURNAME/GIVEN, upper case, ASCII only', () => {
    expect(toLegacyPassengerName('Uzair', 'Rafi')).toBe('RAFI/UZAIR');
    expect(toLegacyPassengerName('Élodie', "O'Brien-Côté")).toBe('OBRIENCOTE/ELODIE');
    expect(toLegacyPassengerName('Mary Ann', 'van der Berg')).toBe('VANDERBERG/MARY ANN');
    expect(toLegacyPassengerName('A'.repeat(40), 'B'.repeat(40))).toHaveLength(30);
    expect(() => toLegacyPassengerName('李', '王')).toThrow(LegacyFormatError);
  });

  test('seat rows decode per-position status codes', () => {
    expect(decodeSeatRow('001AH-XA-')).toEqual({
      row: 1,
      seats: [
        { seat: '1A', status: 'available' },
        { seat: '1B', status: 'held' },
        { seat: '1D', status: 'occupied' },
        { seat: '1E', status: 'available' },
      ],
    });
    expect(() => decodeSeatRow('01AAAAAA')).toThrow(LegacyFormatError);
  });
});
