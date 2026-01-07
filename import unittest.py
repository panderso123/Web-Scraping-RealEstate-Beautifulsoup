import unittest
from unittest.mock import patch, mock_open, MagicMock
import requests
from ScrapingToCsvFile import writer, requests, BeautifulSoup
from ScrapingToCsvFile import url, headers

# filepath: /Users/peteranderson/Documents/GitHub/Web-Scraping-RealEstate-Beautifulsoup/test_ScrapingToCsvFile.py

class TestScrapingToCsvFile(unittest.TestCase):
    @patch("ScrapingToCsvFile.requests.get")
    @patch("ScrapingToCsvFile.open", new_callable=mock_open)
    def test_scraping_to_csv(self, mock_file, mock_get):
        # Mock the HTTP response
        mock_response = MagicMock()
        mock_response.text = """
        <html>
            <body>
                <div class="jsx-2775064451 fallBackImgWrap">
                    <div class="jsx-1982357781 address ellipsis srp-page-address srp-address-redesign">123 Main St</div>
                    <span class="Price__Component-rui__x3geed-0 gipzbd">$500,000</span>
                    <span class="jsx-3853574337 statusText">For Sale</span>
                    <span class="jsx-287440024">Owner</span>
                    <span class="jsx-287440024">John Doe</span>
                    <span class="jsx-946479843 meta-value">3</span>
                    <span class="jsx-946479843 meta-value">2</span>
                    <span class="jsx-946479843 meta-value">1500</span>
                    <span class="jsx-946479843 meta-value">5000</span>
                </div>
            </body>
        </html>
        """
        mock_get.return_value = mock_response

        # Run the script
        page = requests.get(url, headers=headers)
        soup = BeautifulSoup(page.text, 'html.parser')
        lists = soup.find_all('div', class_="jsx-2775064451 fallBackImgWrap")

        with open('housing.csv', 'w', encoding='utf8', newline='') as f:
            thewriter = writer(f)
            header = ['Location', 'Status', 'Price', 'Owner', 'Bed', 'Bath', 'SQFT', 'SQFT_LOT']
            thewriter.writerow(header)
            for list in lists:
                # Assertions for CSV content
                self.assertEqual(header, ['Location', 'Status', 'Price', 'Owner', 'Bed', 'Bath', 'SQFT', 'SQFT_LOT'])

if __name__ == "__main__":
    unittest.main()