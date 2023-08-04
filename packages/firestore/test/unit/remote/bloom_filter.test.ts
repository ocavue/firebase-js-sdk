/**
 * @license
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { expect } from 'chai';

import { normalizeByteString } from '../../../src/model/normalize';
import { BloomFilter } from '../../../src/remote/bloom_filter';

import * as TEST_DATA from './bloom_filter_golden_test_data';

describe('BloomFilter', () => {
  it('can instantiate an empty bloom filter', () => {
    const bloomFilter = new BloomFilter(new Uint8Array(0), 0, 0);
    expect(bloomFilter.bitCount).to.equal(0);
  });

  it('should throw error if empty bloom filter inputs are invalid', () => {
    expect(() => new BloomFilter(new Uint8Array(0), 1, 0)).to.throw(
      'Invalid padding when bitmap length is 0: 1'
    );
    expect(() => new BloomFilter(new Uint8Array(0), 0, -1)).to.throw(
      'Invalid hash count: -1'
    );
  });

  it('can instantiate a non empty bloom filter', () => {
    const bloomFilter0 = new BloomFilter(new Uint8Array(1), 0, 1);
    const bloomFilter1 = new BloomFilter(new Uint8Array(1), 1, 1);
    const bloomFilter2 = new BloomFilter(new Uint8Array(1), 2, 1);
    const bloomFilter3 = new BloomFilter(new Uint8Array(1), 3, 1);
    const bloomFilter4 = new BloomFilter(new Uint8Array(1), 4, 1);
    const bloomFilter5 = new BloomFilter(new Uint8Array(1), 5, 1);
    const bloomFilter6 = new BloomFilter(new Uint8Array(1), 6, 1);
    const bloomFilter7 = new BloomFilter(new Uint8Array(1), 7, 1);

    expect(bloomFilter0.bitCount).to.equal(8);
    expect(bloomFilter1.bitCount).to.equal(7);
    expect(bloomFilter2.bitCount).to.equal(6);
    expect(bloomFilter3.bitCount).to.equal(5);
    expect(bloomFilter4.bitCount).to.equal(4);
    expect(bloomFilter5.bitCount).to.equal(3);
    expect(bloomFilter6.bitCount).to.equal(2);
    expect(bloomFilter7.bitCount).to.equal(1);
  });

  it('should throw error if padding is invalid', () => {
    expect(() => new BloomFilter(new Uint8Array(1), -1, 1)).to.throw(
      'Invalid padding: -1'
    );
    expect(() => new BloomFilter(new Uint8Array(1), 8, 1)).to.throw(
      'Invalid padding: 8'
    );
  });

  it('should throw error if hash count is negative', () => {
    expect(() => new BloomFilter(new Uint8Array(1), 1, -1)).to.throw(
      'Invalid hash count: -1'
    );
  });

  it('should throw error if hash count is 0 for non empty bloom filter', () => {
    expect(() => new BloomFilter(new Uint8Array(1), 1, 0)).to.throw(
      'Invalid hash count: 0'
    );
  });

  it('should be able to process non standard characters', () => {
    // A non-empty BloomFilter object with 1 insertion : "ÀÒ∑"
    const bloomFilter = new BloomFilter(new Uint8Array([237, 5]), 5, 8);
    expect(bloomFilter.mightContain('ÀÒ∑')).to.be.true;
    expect(bloomFilter.mightContain('Ò∑À')).to.be.false;
  });

  it('mightContain in empty bloom filter should always return false', () => {
    const bloomFilter = new BloomFilter(new Uint8Array(0), 0, 0);
    expect(bloomFilter.mightContain('')).to.be.false;
    expect(bloomFilter.mightContain('abc')).to.be.false;
  });

  it('mightContain on empty string might return false positive result', () => {
    const bloomFilter1 = new BloomFilter(new Uint8Array([1]), 1, 1);
    const bloomFilter2 = new BloomFilter(new Uint8Array([255]), 0, 16);
    expect(bloomFilter1.mightContain('')).to.be.false;
    expect(bloomFilter2.mightContain('')).to.be.true;
  });

  /**
   * Golden tests are generated by backend based on inserting n number of
   * document paths into a bloom filter.
   *
   * Full document path is generated by concatenating documentPrefix and number
   * n, eg, projects/project-1/databases/database-1/documents/coll/doc12.
   *
   * The test result is generated by checking the membership of documents from
   * documentPrefix+0 to documentPrefix+2n. The membership results from 0 to n
   * is expected to be true, and the membership results from n to 2n is
   * expected to be false with some false positive results.
   */
  describe('BloomFilter golden tests', () => {
    const documentPrefix =
      'projects/project-1/databases/database-1/documents/coll/doc';

    interface GoldenTestInput {
      bits: {
        bitmap: string;
        padding: number;
      };
      hashCount: number;
    }

    interface GoldenTestExpectedResult {
      membershipTestResults: string;
    }

    function testBloomFilterAgainstExpectedResult(
      bloomFilterInputs: GoldenTestInput,
      expectedResult: GoldenTestExpectedResult
    ): void {
      const {
        bits: { bitmap, padding },
        hashCount
      } = bloomFilterInputs;
      const { membershipTestResults } = expectedResult;

      const byteArray = normalizeByteString(bitmap).toUint8Array();
      const bloomFilter = new BloomFilter(byteArray, padding, hashCount);
      for (let i = 0; i < membershipTestResults.length; i++) {
        const expectedMembershipResult = membershipTestResults[i] === '1';
        const mightContain = bloomFilter.mightContain(documentPrefix + i);
        expect(mightContain).to.equal(expectedMembershipResult);
      }
    }

    it('mightContain result for 1 document with 1 false positive rate', () => {
      testBloomFilterAgainstExpectedResult(
        TEST_DATA.count1Rate1TestData,
        TEST_DATA.count1Rate1TestResult
      );
    });
    it('mightContain result for 1 document with 0.01 false positive rate', () => {
      testBloomFilterAgainstExpectedResult(
        TEST_DATA.count1Rate01TestData,
        TEST_DATA.count1Rate01TestResult
      );
    });
    it('mightContain result for 1 document with 0.0001 false positive rate', () => {
      testBloomFilterAgainstExpectedResult(
        TEST_DATA.count1Rate0001TestData,
        TEST_DATA.count1Rate0001TestResult
      );
    });
    it('mightContain result for 500 documents with 1 false positive rate', () => {
      testBloomFilterAgainstExpectedResult(
        TEST_DATA.count500Rate1TestData,
        TEST_DATA.count500Rate1TestResult
      );
    });
    it('mightContain result for 500 documents with 0.01 false positive rate', () => {
      testBloomFilterAgainstExpectedResult(
        TEST_DATA.count500Rate01TestData,
        TEST_DATA.count500Rate01TestResult
      );
    });
    it('mightContain result for 500 document with 0.0001 false positive rate', () => {
      testBloomFilterAgainstExpectedResult(
        TEST_DATA.count500Rate0001TestData,
        TEST_DATA.count500Rate0001TestResult
      );
    });
    it('mightContain result for 5000 documents with 1 false positive rate', () => {
      testBloomFilterAgainstExpectedResult(
        TEST_DATA.count5000Rate1TestData,
        TEST_DATA.count5000Rate1TestResult
      );
    });
    it('mightContain result for 5000 documenta with 0.01 false positive rate', () => {
      testBloomFilterAgainstExpectedResult(
        TEST_DATA.count5000Rate01TestData,
        TEST_DATA.count5000Rate01TestResult
      );
    });
    it('mightContain result for 5000 documenta with 0.0001 false positive rate', () => {
      testBloomFilterAgainstExpectedResult(
        TEST_DATA.count5000Rate0001TestData,
        TEST_DATA.count5000Rate0001TestResult
      );
    });
    it('mightContain result for 50000 documents with 1 false positive rate', () => {
      testBloomFilterAgainstExpectedResult(
        TEST_DATA.count50000Rate1TestData,
        TEST_DATA.count50000Rate1TestResult
      );
    });
    it('mightContain result for 50000 documents with 0.01 false positive rate', () => {
      testBloomFilterAgainstExpectedResult(
        TEST_DATA.count50000Rate01TestData,
        TEST_DATA.count50000Rate01TestResult
      );
      //Extend default timeout(2000)
    })
      .timeout(60_000)
      .retries(3);
    it('mightContain result for 50000 documents with 0.0001 false positive rate', () => {
      testBloomFilterAgainstExpectedResult(
        TEST_DATA.count50000Rate0001TestData,
        TEST_DATA.count50000Rate0001TestResult
      );
      //Extend default timeout(2000)
    })
      .timeout(60_000)
      .retries(3);
  });
});
